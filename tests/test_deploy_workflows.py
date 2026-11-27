from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_frontend_deploy_ships_local_config_helper():
    text = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
    # The deploy job ships the helper to the host and drives the nginx config
    # through it (symlink pinning + atomic install + restore on rollback).
    assert "deploy/pxed-local-config.sh" in text
    assert "pxed_ensure_local_config_link" in text
    assert "pxed_atomic_install_local_config" in text
    # tencent-lh runs Debian nginx with the stock conf.d include: the managed
    # path is the symlink target under /opt/one-mail-frontend, reload is plain
    # systemctl (no custom -c/-p prefix like on the old pxed host).
    assert "CONF=/etc/nginx/conf.d/one-mail-frontend.conf" in text
    assert "systemctl reload nginx" in text


def test_aggregator_remote_stage_cleanup_survives_rollback_trap():
    text = (ROOT / ".github/workflows/aggregator_deploy.yaml").read_text(encoding="utf-8")
    assert 'restore_previous "$status"' in text
    assert 'rm -rf "$STAGE" "$REMOTE_STAGE"' in text
    assert "trap cleanup_remote_stage EXIT" in text
    assert 'git diff-tree -m --no-commit-id --name-only -r "$GITHUB_SHA"' in text


def test_shard_template_declares_attachment_storage_contract():
    text = (ROOT / "worker/wrangler.shard1.toml.example").read_text(encoding="utf-8")
    vars_block = text.split("[vars]", 1)[1].split("[[d1_databases]]", 1)[0]
    assert "ATTACHMENT_STORAGE_URL" in vars_block
    assert "ATTACHMENT_STORAGE_TOKEN" in text


def test_worker_cors_exposes_attachment_filename_header_for_browser_downloads():
    text = (ROOT / "worker/src/worker.ts").read_text(encoding="utf-8")
    assert text.count("exposeHeaders: ['Content-Disposition']") == 2


def test_d1_backup_is_optional_and_ci_managed():
    workflow = (ROOT / ".github/workflows/aggregator_deploy.yaml").read_text(encoding="utf-8")
    installer = (ROOT / "aggregator/deploy/d1-backup-install.sh").read_text(encoding="utf-8")
    # The workflow stays under its line budget by delegating to the installer.
    assert "d1-backup-install.sh\" install" in workflow
    assert "d1-backup-install.sh status" in workflow
    assert "D1_BACKUP_API_TOKEN is not set" in workflow
    # The backup program must never become a hard deploy dependency: it is
    # installed only when both the staged token and the operator config exist.
    assert 'if [ ! -f "${STAGE:-/nonexistent}/d1-backup.token" ]' in installer
    assert 'if [ ! -f "$BASE/d1-backup.json" ]' in installer
    # tencent-lh is systemd-native: the installer drives one-mail-d1-backup.service.
    assert "systemctl enable --now" in installer
    assert "one-mail-d1-backup.service" in installer
    # A missing or stopped backup must not fail the mail deployment.
    assert "::warning::D1 backup is not running" in installer
    unit = (ROOT / "aggregator/deploy/one-mail-d1-backup.service").read_text(encoding="utf-8")
    assert "ExecStart=/opt/one-mail-agg/d1-backup.sh" in unit
    assert "Nice=19" in unit


def test_d1_backup_unit_yields_cpu_and_io_to_mail_delivery():
    text = (ROOT / "aggregator/deploy/one-mail-d1-backup.service").read_text(encoding="utf-8")
    # The nightly dump must never compete with IMAP IDLE / the 60s poll.
    assert "Nice=19" in text
    assert "IOSchedulingClass=idle" in text
    assert "Restart=always" in text


def test_d1_backup_yields_cpu_and_io_to_mail_delivery():
    text = (ROOT / "aggregator/deploy/d1-backup.sh").read_text(encoding="utf-8")
    # The nightly dump must never compete with IMAP IDLE / the 60s poll.
    assert "nice -n 19" in text
    assert "ionice -c 3" in text
    # ...but a host without those tools must not turn this into a crash loop.
    assert "command -v nice" in text
    assert "command -v ionice" in text
