import time
import requests

from .config import Config


def upload_emails(config: Config, emails: list[dict], max_retries: int = 5, chunk_size: int = 15) -> dict:
    """上传邮件列表到 Worker API。

    使用 chunk_size 分块上传（默认 15 封）：
    1. 避免单次请求报文体积过大（包含 HTML/附件）导致 Cloudflare edge 报 524 / 503 / read timeout；
    2. Cloudflare D1 写入保持在数秒以内，平滑避免触发 Cloudflare edge 网关超时；
    3. 超时时间设置为 45s，重试采用指数退避。
    """
    if not emails:
        return {"inserted": 0, "skipped": 0}

    url = f"{config.worker_base_url}/admin/unified/ingest"
    headers = {"x-admin-auth": config.admin_token, "Content-Type": "application/json"}

    total_inserted = 0
    total_skipped = 0

    for i in range(0, len(emails), chunk_size):
        chunk = emails[i:i + chunk_size]
        delay = 1.0
        last = None
        success = False

        for attempt in range(max_retries):
            try:
                r = requests.post(url, json={"emails": chunk}, headers=headers, timeout=45)
                if r.status_code == 200:
                    res = r.json()
                    total_inserted += res.get("inserted", 0)
                    total_skipped += res.get("skipped", 0)
                    success = True
                    break
                last = f"HTTP {r.status_code}: {r.text[:200]}"
            except Exception as e:
                last = str(e)

            if attempt < max_retries - 1:
                time.sleep(delay)
                delay = min(delay * 2, 30)

        if not success:
            raise RuntimeError(f"upload failed for chunk of {len(chunk)} emails after {max_retries} attempts: {last}")

    return {"inserted": total_inserted, "skipped": total_skipped}


def upload_folders(config: Config, folders: list[dict], max_retries: int = 3, chunk_size: int = 100) -> dict:
    """把 provider folder catalog 写入同一个 admin ingest endpoint。

    folder payload 很小，允许更大的 chunk；Worker 负责幂等 upsert。该通路用于登记
    没有任何邮件的空文件夹，因此不能依赖邮件 ingest 顺带发现。
    """
    if not folders:
        return {"folders_upserted": 0}

    url = f"{config.worker_base_url}/admin/unified/ingest"
    headers = {"x-admin-auth": config.admin_token, "Content-Type": "application/json"}
    total = 0

    for i in range(0, len(folders), chunk_size):
        chunk = folders[i:i + chunk_size]
        delay = 1.0
        last = None
        success = False

        for attempt in range(max_retries):
            try:
                r = requests.post(url, json={"folders": chunk}, headers=headers, timeout=20)
                if r.status_code == 200:
                    res = r.json()
                    total += int(res.get("folders_upserted", len(chunk)))
                    success = True
                    break
                last = f"HTTP {r.status_code}: {r.text[:200]}"
            except Exception as e:
                last = str(e)

            if attempt < max_retries - 1:
                time.sleep(delay)
                delay = min(delay * 2, 10)

        if not success:
            raise RuntimeError(
                f"folder catalog upload failed for chunk of {len(chunk)} folders "
                f"after {max_retries} attempts: {last}"
            )

    return {"folders_upserted": total}
