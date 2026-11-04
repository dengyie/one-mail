"""One bounded retry for the Worker calls whose response is safe to lose."""

from unittest.mock import patch

import pytest
import requests

from one_mail_agg.transport_retry import call_with_transport_retry


@pytest.mark.parametrize("error", [
    requests.exceptions.ReadTimeout("stalled"),
    requests.exceptions.ConnectTimeout("stalled"),
    requests.exceptions.ConnectionError("reset"),
    requests.exceptions.ProxyError("proxy refused"),
    requests.exceptions.SSLError("tls eof"),
])
def test_transport_failures_are_retried_once(error):
    calls = []

    def call():
        calls.append(1)
        if len(calls) < 2:
            raise error
        return "ok"

    with patch("one_mail_agg.transport_retry.time.sleep") as sleep:
        assert call_with_transport_retry(call) == "ok"
    assert len(calls) == 2
    sleep.assert_called_once_with(0.5)


def test_the_last_transport_failure_propagates():
    calls = []

    def call():
        calls.append(1)
        raise requests.ConnectionError("down")

    with patch("one_mail_agg.transport_retry.time.sleep"):
        with pytest.raises(requests.ConnectionError):
            call_with_transport_retry(call)
    assert len(calls) == 2


def test_non_transport_errors_are_not_retried():
    calls = []

    def call():
        calls.append(1)
        raise ValueError("bad payload")

    with patch("one_mail_agg.transport_retry.time.sleep") as sleep:
        with pytest.raises(ValueError):
            call_with_transport_retry(call)
    assert len(calls) == 1
    sleep.assert_not_called()


def test_the_attempt_budget_is_bounded():
    calls = []

    def call():
        calls.append(1)
        raise requests.ReadTimeout("stalled")

    with patch("one_mail_agg.transport_retry.time.sleep"):
        with pytest.raises(requests.ReadTimeout):
            call_with_transport_retry(call, attempts=4)
    assert len(calls) == 4
