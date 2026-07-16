import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  NotImplementedException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { SessionService } from './session.service';
import { SseTicketService } from './sse-ticket.service';
import { LoginThrottleService } from './login-throttle.service';
import { code2session, isWeChatConfigured } from './wechat';
import { isUuid, TenantGuard, extractSessionToken, type TenantRequest } from '../tenant/tenant.guard';
import { AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from './session.types';

/** Minimal response shape we use (avoids an express type dependency). */
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

const COOKIE = 'cv_session';
function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}
/**
 * Set the HttpOnly session cookie (P0-2 sub-issue 2 — the token is delivered here, never in a shape
 * the browser can read from JS/localStorage). In production the frontend (Vercel) and API (Render) are
 * on DIFFERENT sites, so the cookie must be `SameSite=None; Secure` to be sent on cross-site XHR/SSE;
 * `HttpOnly` keeps it unreadable to JS (XSS can't exfiltrate it). In dev (same-site localhost, plain
 * http) we use `SameSite=Lax` and omit `Secure` so it works without TLS.
 */
function setSessionCookie(res: HttpResponse, token: string, maxAgeSec: number): void {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAgeSec}`];
  parts.push(isProd() ? 'SameSite=None' : 'SameSite=Lax');
  if (isProd()) parts.push('Secure'); // required by browsers whenever SameSite=None
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Best-effort client IP for throttling: first X-Forwarded-For hop (Render sets it), else a constant. */
function clientIp(req: TenantRequest): string {
  const xff = req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.header('x-real-ip') ?? 'unknown';
}

/**
 * P5/T1 STAGING login gate: shared with the manager + staff staging logins. Enabled only when
 * STAGING_LOGIN_ENABLED=true and a STAGING_LOGIN_PASSWORD is set; compares in constant time.
 * Returns the server-side staging tenant. Absent the flag/password it throws NotFound, so a real
 * prod deployment (which sets neither) never exposes these endpoints.
 */
function assertStagingPassword(password: unknown): string {
  const expected = process.env.STAGING_LOGIN_PASSWORD ?? '';
  if (process.env.STAGING_LOGIN_ENABLED !== 'true' || expected.length === 0) throw new NotFoundException();
  const provided = Buffer.from(typeof password === 'string' ? password : '');
  const want = Buffer.from(expected);
  if (provided.length !== want.length || !timingSafeEqual(provided, want)) {
    throw new UnauthorizedException('invalid staging password');
  }
  const tenantId = process.env.STAGING_TENANT_ID ?? '11111111-1111-1111-1111-111111111111';
  if (!isUuid(tenantId)) throw new BadRequestException('STAGING_TENANT_ID must be a uuid');
  return tenantId;
}

/**
 * Session issuance. Staff authenticate via WeChat (wx.login → code2session → openid → session);
 * managers via a real login + password (POST /auth/manager/login) that works in production. The
 * dev-login endpoints are the NODE_ENV-gated mock of that flow for local/CI synthetic data — they
 * 404 in production. No endpoint here trusts a client-supplied tenant/staff for DATA access; they
 * only MINT sessions, which the guard then trusts — and the manager's tenant/role come from the
 * server-side manager_identities row, never the request body.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly tickets: SseTicketService,
    private readonly throttle: LoginThrottleService,
  ) {}

  /** PROD staff login. Requires WeChat credentials (founder dependency) — 501 until configured. */
  @Post('staff/wx-login')
  async wxLogin(@Body() body: { code?: string }, @Res({ passthrough: true }) res: HttpResponse) {
    if (!isWeChatConfigured()) {
      throw new NotImplementedException(
        'WeChat login is not configured (WX_APPID/WX_APPSECRET). Use /auth/staff/dev-login in development.',
      );
    }
    if (!body?.code) throw new BadRequestException('code is required');
    const { openid } = await code2session(body.code);
    const { token, identity } = await this.sessions.issueStaffByOpenid(openid);
    setSessionCookie(res, token, 12 * 3600);
    return { token, identity };
  }

  /** DEV-ONLY mock of wx.login for staff. 404 in production. */
  @Post('staff/dev-login')
  async devStaffLogin(
    @Body() body: { tenantId?: string; handle?: string; openid?: string; displayName?: string },
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    if (isProd()) throw new NotFoundException();
    if (!isUuid(body?.tenantId)) throw new BadRequestException('tenantId (uuid) is required');
    if (!body?.handle) throw new BadRequestException('handle is required');
    const { token, identity } = await this.sessions.devLoginStaff({
      tenantId: body.tenantId,
      handle: body.handle,
      openid: body.openid,
      displayName: body.displayName,
    });
    setSessionCookie(res, token, 12 * 3600);
    return { token, identity };
  }

  /**
   * T1 STAGING staff login — the staff counterpart to the manager staging login. Same env-gated,
   * password-protected mechanism (NOT the wide-open dev-login, which stays 404 in prod). Lets a
   * phone terminal obtain a real staff session on staging (NODE_ENV=production) so /reports and
   * /uploads authenticate instead of 401ing on the dev X-Tenant-Id shim. Tenant is server-side;
   * the staff is provisioned/looked-up by `handle` within that tenant.
   */
  @Post('staff/staging-login')
  async stagingStaffLogin(
    @Body() body: { password?: string; handle?: string; displayName?: string },
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const tenantId = assertStagingPassword(body?.password);
    const handle = typeof body?.handle === 'string' && body.handle.trim().length > 0 ? body.handle.trim() : 'staff';
    const { token, identity } = await this.sessions.devLoginStaff({
      tenantId,
      handle,
      displayName: body?.displayName,
    });
    setSessionCookie(res, token, 12 * 3600);
    return { token, identity };
  }

  /**
   * PROD manager login — real credential authentication (login + password), usable in production.
   * The password is checked (constant-time) against the stored scrypt hash; the tenant + role come
   * from the server-side manager_identities row (never the client). Wrong/unknown credentials return
   * a generic 401 with no user-enumeration. This is NOT NODE_ENV-gated — it is the intended pilot/
   * production sign-in. (The wide-open manager/dev-login below stays 404 in production.)
   */
  @Post('manager/login')
  async managerLogin(
    @Body() body: { login?: string; password?: string },
    @Req() req: TenantRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const login = typeof body?.login === 'string' ? body.login.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!login || !password) throw new BadRequestException('login and password are required');
    // Failed-login lockout (P0-2 sub-issue 4b): a locked key is rejected with 429 BEFORE any verify,
    // so even a correct password is refused until the lockout window clears.
    const key = `${login.toLowerCase()}|${clientIp(req)}`;
    this.throttle.assertNotLocked(key);
    try {
      const { token, identity } = await this.sessions.loginManager({ login, password });
      this.throttle.recordSuccess(key);
      setSessionCookie(res, token, 12 * 3600);
      return { token, identity };
    } catch (err) {
      if (err instanceof UnauthorizedException) this.throttle.recordFailure(key);
      throw err;
    }
  }

  /** DEV-ONLY mock manager login. 404 in production. Prod manager login = POST /auth/manager/login. */
  @Post('manager/dev-login')
  async devManagerLogin(
    @Body() body: { tenantId?: string; login?: string; displayName?: string; role?: string },
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    if (isProd()) throw new NotFoundException();
    if (!isUuid(body?.tenantId)) throw new BadRequestException('tenantId (uuid) is required');
    if (!body?.login) throw new BadRequestException('login is required');
    const { token, identity } = await this.sessions.devLoginManager({
      tenantId: body.tenantId,
      login: body.login,
      displayName: body.displayName,
      role: body.role,
    });
    setSessionCookie(res, token, 12 * 3600);
    return { token, identity };
  }

  /**
   * P5 STAGING manager login — minimal + secure, for a public synthetic-data staging env. It is
   * NOT the wide-open dev-login (that stays 404 in production). Gated by STAGING_LOGIN_ENABLED +
   * a shared STAGING_LOGIN_PASSWORD (constant-time compare); the tenant comes from STAGING_TENANT_ID
   * server-side, never the client. Absent the flag/password it 404s, so real prod never exposes it.
   */
  @Post('manager/staging-login')
  async stagingManagerLogin(@Body() body: { password?: string }, @Res({ passthrough: true }) res: HttpResponse) {
    const tenantId = assertStagingPassword(body?.password);
    const { token, identity } = await this.sessions.devLoginManager({
      tenantId,
      login: 'staging-manager',
      displayName: 'Staging Manager',
      role: 'manager',
    });
    setSessionCookie(res, token, 12 * 3600);
    return { token, identity };
  }

  @Post('logout')
  async logout(@Req() req: TenantRequest, @Res({ passthrough: true }) res: HttpResponse) {
    const token = extractSessionToken(req);
    if (token) await this.sessions.logout(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    return { ok: true };
  }

  /** Who am I — resolved from the session (or the dev shim). Requires the guard. */
  @Get('me')
  @UseGuards(TenantGuard)
  me(@AuthIdentity() identity: SessionIdentity) {
    if (!identity) throw new UnauthorizedException();
    return identity;
  }

  /**
   * P0-2 sub-issue 3: mint a short-lived, single-use SSE ticket. The caller must already be
   * authenticated (cookie/bearer via TenantGuard); the ticket is bound to that identity and redeemed
   * once by GET /objects/stream?ticket=. This replaces putting the raw session token in the SSE URL.
   */
  @Post('sse-ticket')
  @UseGuards(TenantGuard)
  sseTicket(@AuthIdentity() identity: SessionIdentity) {
    if (!identity) throw new UnauthorizedException();
    return { ticket: this.tickets.issue(identity) };
  }
}
