#!/usr/bin/env python3
"""MSA（Hotmail / Outlook.com 个人号）OAuth2 一次性授权引导脚本。

作用
----
用 Microsoft Device Code Flow 获取一个 @hotmail.com / @outlook.com / @live.com
个人账号的 **refresh_token**（长活，有效期可长达数年/会话），并把可直接粘贴进
one-mail `config.json`（或 Worker `user_mail_accounts.oauth`）的 JSON 块打印出来。

为什么需要它
------------
微软已对所有租户禁用 IMAP 基础认证（含 App Password 对部分账号不可用）。
个人 Hotmail/Outlook.com 唯一受支持接入方式 = OAuth2 + XOAUTH2（scope
`https://outlook.office.com/IMAP.AccessAsUser.All offline_access`）。
Device Code Flow 是官方推荐的**免回调、公网客户端（无需 client_secret）**流程，
适合个人账号自动化收信。

用法
----
    # 1. 需要一个公开客户端 ID（App Registration，Supported account types =
    #    "Personal Microsoft accounts only"；不需要 secret）
    python aggregator/scripts/msa_authorize.py --client-id <CLIENT_ID>

    # 2. 按提示用目标 hotmail 账号在浏览器登录并输入显示的用户码
    # 3. 成功后脚本打印 JSON 配置块，粘贴进 config.json：

    {
      "provider": "msa",
      "client_id": "<CLIENT_ID>",
      "refresh_token": "<long-lived refresh token>"
    }

    # 4. 也可选 --tenant consumers（默认）或 --tenant common

注意事项
--------
- refresh_token 是长活凭据，务必只保存进 pxed config.json（chmod 600）或
  D1 oauth_enc（AES-GCM）；不要提交到 git、不要贴进日志。
- 本脚本不触碰 one-mail 代码，只是换取 token 的引导工具。
- 依赖：`msal`（one-mail-agg 的 pyproject 已声明）。
"""
import argparse
import json
import sys
import time
import webbrowser

import msal


def build_app(client_id: str, tenant: str) -> msal.PublicClientApplication:
    authority = f"https://login.microsoftonline.com/{tenant}"
    return msal.PublicClientApplication(client_id, authority=authority)


def run_device_flow(app: msal.PublicClientApplication, scopes: list[str]) -> dict:
    flow = app.initiate_device_flow(scopes=scopes)
    if "user_code" not in flow:
        raise RuntimeError(f"device flow initiation failed: {flow}")

    print("\n" + "=" * 64)
    print("1) 在浏览器打开（已尝试自动打开）：")
    print("   " + flow["verification_uri"])
    print(f"2) 使用代码：** {flow['user_code']} **")
    print("3) 用目标 Hotmail/Outlook 账号登录并允许访问。")
    print("   等待授权（最多 %s 秒）..." % flow.get("expires_in", 900))
    print("=" * 64 + "\n")

    try:
        webbrowser.open(flow["verification_uri"])
    except Exception:
        pass  # 无浏览器环境（如 SSH）时用户手动打开即可

    # 轮询直到用户完成授权
    deadline = time.time() + flow.get("expires_in", 900)
    while time.time() < deadline:
        time.sleep(flow.get("interval", 5))
        result = app.acquire_token_by_device_flow(flow)
        if "access_token" in result:
            return result
        err = result.get("error")
        if err == "authorization_pending":
            continue
        if err in {"authorization_declined", "expired_token", "bad_verification_code"}:
            raise RuntimeError(f"device flow failed: {err}: {result.get('error_description')}")
        # 其它未知错误：继续轮询但给出提示，避免静默死循环
        print(f"[poll] {result.get('error')}: {result.get('error_description')}", file=sys.stderr)
    raise TimeoutError("device flow timed out waiting for user authorization")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--client-id", required=True,
                        help="公开客户端 ID（App Registration，Personal Microsoft accounts only）")
    parser.add_argument("--tenant", default="consumers",
                        help="token 端点租户：consumers（个人号，默认）/ common（含组织）")
    args = parser.parse_args()

    scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All", "offline_access"]
    if args.tenant == "common":
        # common 场景可再加 openid/profile 便于部分账号解析 preferred_username
        scopes = ["openid", "profile", "email"] + scopes

    app = build_app(args.client_id, args.tenant)
    try:
        result = run_device_flow(app, scopes)
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        return 1

    refresh_token = result.get("refresh_token")
    if not refresh_token:
        print("[ERROR] token 响应中没有 refresh_token（可能 scope 缺 offline_access）", file=sys.stderr)
        return 1

    config = {
        "provider": "msa",
        "client_id": args.client_id,
        "refresh_token": refresh_token,
    }

    print("\n" + "=" * 64)
    print("授权成功！请把下面 JSON 粘贴进 one-mail config.json 的 accounts[]（或")
    print("user_mail_accounts 的 oauth 字段）：\n")
    print(json.dumps(config, indent=2, ensure_ascii=False))
    print("\n" + "=" * 64)
    print("⚠️  refresh_token 是长活凭据：只存 pxed config.json(chmod 600) / D1 oauth_enc；")
    print("    不要提交 git、不要贴进日志。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())