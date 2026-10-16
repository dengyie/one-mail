from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def test_frontend_sparse_checkout_includes_local_config_helper():
    text = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
    match = re.search(
        r"sparse-checkout:\s*(.*?)\n\s*sparse-checkout-cone:",
        text,
        re.S,
    )
    assert match, "deploy-pxed sparse checkout block is missing"
    assert "deploy/pxed-local-config.sh" in match.group(1)


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
