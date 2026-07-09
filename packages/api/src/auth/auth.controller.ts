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
function setSessionCookie(res: HttpResponse, token: string, maxAgeSec: number): void {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isProd()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Session issuance. Staff authenticate via WeChat (wx.login → code2session → openid → session);
 * managers via a login. The dev-login endpoints are the NODE_ENV-gated mock of that flow for
 * local/CI synthetic data — they 404 in production. No endpoint here trusts a client-supplied
 * tenant/staff for DATA access; they only MINT sessions, which the guard then trusts.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly sessions: SessionService) {}

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

  /** DEV-ONLY mock manager login. 404 in production. Prod manager login (magic link/SSO) = TODO. */
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
    const expected = process.env.STAGING_LOGIN_PASSWORD ?? '';
    if (process.env.STAGING_LOGIN_ENABLED !== 'true' || expected.length === 0) throw new NotFoundException();
    const provided = Buffer.from(typeof body?.password === 'string' ? body.password : '');
    const want = Buffer.from(expected);
    if (provided.length !== want.length || !timingSafeEqual(provided, want)) {
      throw new UnauthorizedException('invalid staging password');
    }
    const tenantId = process.env.STAGING_TENANT_ID ?? '11111111-1111-1111-1111-111111111111';
    if (!isUuid(tenantId)) throw new BadRequestException('STAGING_TENANT_ID must be a uuid');
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
}
