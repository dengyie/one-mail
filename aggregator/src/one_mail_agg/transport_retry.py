"""重试一次在后端/代理路径上被拖住的请求。

代理出口偶发几十秒级的停顿（production 日志里 ReadTimeout/ConnectionError/
SSLError 每小时数次），而这条路径上的请求都是「丢了响应也没关系」的：

- claim 只取一个短租约，响应丢失时租约自行过期，不会重复处理；
- fetch_user_accounts 是只读列表；
- report_sync_status 写的是幂等状态（同一份 error/last_sync_at 重发无副作用）。

所以一次即时重试就能吸收这种抖动，调用方不必为它再各写一套退避逻辑。
非传输层错误不重试：掩盖真实故障比抖动更糟。
"""
import logging
import time

import requests

log = logging.getLogger("one-mail-agg")

TRANSPORT_ERRORS = (requests.exceptions.Timeout, requests.exceptions.ConnectionError)
RETRY_ATTEMPTS = 2
RETRY_DELAY_SECONDS = 0.5


def call_with_transport_retry(call, *, attempts: int = RETRY_ATTEMPTS,
                              delay: float = RETRY_DELAY_SECONDS):
    """执行 ``call``，仅在传输层失败时重试，最后一次失败照原样抛出。"""
    for attempt in range(attempts):
        try:
            return call()
        except TRANSPORT_ERRORS as exc:
            if attempt + 1 >= attempts:
                raise
            log.debug("transport retry %d/%d after %s", attempt + 1, attempts - 1, exc)
            time.sleep(delay)
