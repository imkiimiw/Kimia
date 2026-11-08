import hashlib
import hmac

import pytest

from app.security import AuthError, sign, verify

S = "k" * 40
N = "nonce-0123456789abcdef"


def mk():
    store = set()

    def f(nonce):
        if nonce in store:
            return False
        store.add(nonce)
        return True
    return f


def test_sign_matches_the_documented_format():
    expected = hmac.new(S.encode(), f"1700000000.{N}.POST./v1/jobs.".encode() + b'{"a":1}', hashlib.sha256).hexdigest()
    assert sign(S, 1700000000, N, "post", "/v1/jobs", b'{"a":1}') == expected


def test_valid_request_passes_once_then_replay_is_refused():
    seen = mk()
    sig = sign(S, 1000, N, "POST", "/v1/jobs", b"{}")
    verify(S, "1000", N, sig, "POST", "/v1/jobs", b"{}", seen, now=1000)
    with pytest.raises(AuthError) as e:
        verify(S, "1000", N, sig, "POST", "/v1/jobs", b"{}", seen, now=1001)
    assert e.value.code == "REPLAY"


def test_a_retry_with_a_fresh_nonce_in_the_same_second_passes():
    seen = mk()
    for nonce in (N, N + "x"):
        verify(S, "1000", nonce, sign(S, 1000, nonce, "POST", "/v1/jobs", b"{}"), "POST", "/v1/jobs", b"{}", seen, now=1000)


@pytest.mark.parametrize("ts,nonce,sig,method,path,body,now,code", [
    (None, N, "x", "GET", "/v1/a", b"", 0, "MISSING_SIGNATURE"),
    ("1000", None, "x", "GET", "/v1/a", b"", 0, "MISSING_SIGNATURE"),
    ("1000", "short", "x", "GET", "/v1/a", b"", 0, "BAD_NONCE"),
    ("1000", "bad nonce with spaces!!", "x", "GET", "/v1/a", b"", 0, "BAD_NONCE"),
    ("abc", N, "x", "GET", "/v1/a", b"", 0, "BAD_TIMESTAMP"),
    ("1000", N, None, "GET", "/v1/a", b"", 1000, "MISSING_SIGNATURE"),
    ("1000", N, "OK", "GET", "/v1/a", b"", 1301, "STALE_TIMESTAMP"),
    ("1000", N, "OK", "GET", "/v1/a", b"", 699, "STALE_TIMESTAMP"),
    ("1000", N, "OK", "GET", "/v1/b", b"", 1000, "BAD_SIGNATURE"),     # other path
    ("1000", N, "OK", "POST", "/v1/a", b"", 1000, "BAD_SIGNATURE"),    # other method
    ("1000", N, "OK", "GET", "/v1/a", b"x", 1000, "BAD_SIGNATURE"),    # other body
    ("1000", N + "y", "OK", "GET", "/v1/a", b"", 1000, "BAD_SIGNATURE"),  # other nonce
])
def test_refusals(ts, nonce, sig, method, path, body, now, code):
    if sig == "OK":
        sig = sign(S, 1000, N, "GET", "/v1/a", b"")
    with pytest.raises(AuthError) as e:
        verify(S, ts, nonce, sig, method, path, body, mk(), now=now)
    assert e.value.code == code


def test_wrong_secret_is_refused():
    sig = sign("other" * 10, 1000, N, "GET", "/v1/a", b"")
    with pytest.raises(AuthError):
        verify(S, "1000", N, sig, "GET", "/v1/a", b"", mk(), now=1000)
