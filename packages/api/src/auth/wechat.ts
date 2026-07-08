/**
 * WeChat Mini Program `code2session`: exchanges a wx.login() `code` for the user's stable
 * `openid`. Real network call, enabled ONLY when the app is configured with the Mini Program
 * credentials.
 *
 * !!! TODO(prod) DEPENDENCY (founder to provide): WX_APPID + WX_APPSECRET, and an ICP-filed
 * production API domain. Until those exist, the prod staff path returns 501 and dev uses the
 * gated mock login (/auth/staff/dev-login). No real WeChat call is made with synthetic data. !!!
 */
export interface WeChatSession {
  openid: string;
  unionid?: string;
}

export function isWeChatConfigured(): boolean {
  return Boolean(process.env.WX_APPID && process.env.WX_APPSECRET);
}

export async function code2session(code: string): Promise<WeChatSession> {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_APPSECRET;
  if (!appid || !secret) {
    throw new Error('WeChat is not configured (WX_APPID/WX_APPSECRET missing).');
  }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetch(url);
  const body = (await res.json()) as { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
  if (!body.openid) {
    throw new Error(`WeChat code2session failed: ${body.errcode ?? '?'} ${body.errmsg ?? 'no openid'}`);
  }
  return { openid: body.openid, unionid: body.unionid };
}
