import base64
import pytest
from plexo.proxy.server import (
    is_loopback_host,
    validate_proxy_auth,
    ALLOWED_CONNECT_PORTS,
    LocalBondedProxy,
)


def test_is_loopback_host():
    assert is_loopback_host("127.0.0.1") is True
    assert is_loopback_host("localhost") is True
    assert is_loopback_host("::1") is True
    assert is_loopback_host("127.0.0.2") is True

    # Remote / unsafe addresses
    assert is_loopback_host("0.0.0.0") is False
    assert is_loopback_host("192.168.1.100") is False
    assert is_loopback_host("10.193.133.147") is False
    assert is_loopback_host("example.com") is False


def test_validate_proxy_auth_success():
    expected = "user:secret"
    encoded = base64.b64encode(expected.encode()).decode()
    header = f"Basic {encoded}"
    assert validate_proxy_auth(header, expected) is True


def test_validate_proxy_auth_failures():
    expected = "user:secret"

    # Missing header or credentials
    assert validate_proxy_auth(None, expected) is False
    assert validate_proxy_auth("", expected) is False

    # Wrong credentials
    wrong_encoded = base64.b64encode(b"user:wrong").decode()
    assert validate_proxy_auth(f"Basic {wrong_encoded}", expected) is False

    # Malformed header
    assert validate_proxy_auth("Bearer token123", expected) is False
    assert validate_proxy_auth("Basic !!!not-base64", expected) is False


def test_connect_port_restrictions():
    assert 80 in ALLOWED_CONNECT_PORTS
    assert 443 in ALLOWED_CONNECT_PORTS
    assert 22 not in ALLOWED_CONNECT_PORTS
    assert 25 not in ALLOWED_CONNECT_PORTS
    assert 8080 not in ALLOWED_CONNECT_PORTS


def test_proxy_init_security_guards():
    # Loopback without auth is permitted
    p1 = LocalBondedProxy(host="127.0.0.1")
    assert p1.host == "127.0.0.1"

    # Non-loopback without auth or allow_remote raises ValueError
    with pytest.raises(ValueError):
        LocalBondedProxy(host="0.0.0.0")

    with pytest.raises(ValueError):
        LocalBondedProxy(host="192.168.1.50")

    # Non-loopback WITH auth is permitted
    p2 = LocalBondedProxy(host="0.0.0.0", auth="user:pass")
    assert p2.auth == "user:pass"

    # Non-loopback WITH allow_remote is permitted
    p3 = LocalBondedProxy(host="0.0.0.0", allow_remote=True)
    assert p3.allow_remote is True
