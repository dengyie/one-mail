from imapclient import IMAPClient

from .config import Config, AccountConfig
from .state import SyncState
from .imap_base import fetch_new_messages
from .normalize import normalize_message
from .uploader import upload_emails


def default_client_factory(account: AccountConfig) -> IMAPClient:
    c = IMAPClient(account.host, port=account.port, ssl=account.use_ssl)
    c.login(account.username, account.password)
    return c


def sync_account(client_factory, config: Config, account: AccountConfig, state: SyncState) -> dict:
    client = client_factory(account)
    total = 0
    try:
        for folder in account.folders:
            sel = client.select_folder(folder, readonly=True)
            uidvalidity = int(sel[b"UIDVALIDITY"])
            msgs = fetch_new_messages(client, account, folder, state)
            if not msgs:
                continue
            batch = [normalize_message(m.raw_bytes, account, folder, uidvalidity, m.uid, m.internal_date_ms)
                     for m in msgs]
            upload_emails(config, batch)
            state.set_last_uid(account.id, folder, max(m.uid for m in msgs))
            total += len(batch)
    finally:
        try:
            client.logout()
        except Exception:
            pass
    return {"synced": total}