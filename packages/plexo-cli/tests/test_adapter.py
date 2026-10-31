"""Tests for adapter discovery and classification."""

import pytest
from plexo.core.adapter import classify_interface, is_usable_ip, NetworkAdapter


def test_classify_interface():
    assert classify_interface("Wi-Fi") == "wifi"
    assert classify_interface("WLAN 2") == "wifi"
    assert classify_interface("Ethernet") == "ethernet"
    assert classify_interface("Apple Mobile Device Ethernet") == "usb"
    assert classify_interface("Remote NDIS Compatible Device") == "usb"
    assert classify_interface("Loopback Pseudo-Interface 1") == "other"


def test_is_usable_ip():
    assert is_usable_ip("192.168.1.15") is True
    assert is_usable_ip("10.0.0.5") is True
    assert is_usable_ip("172.16.0.100") is True

    # Invalid / Unusable IPs
    assert is_usable_ip("127.0.0.1") is False  # Loopback
    assert is_usable_ip("169.254.1.2") is False  # Link-local APIPA
    assert is_usable_ip("0.0.0.0") is False  # Unspecified
    assert is_usable_ip("invalid_ip") is False


def test_adapter_display_name():
    adapter = NetworkAdapter(
        name="Wi-Fi",
        ip_address="192.168.1.45",
        netmask="255.255.255.0",
        kind="wifi",
        is_up=True,
    )
    assert "Wi-Fi" in adapter.display_name
    assert "WIFI" in adapter.display_name
    assert "192.168.1.45" in adapter.display_name
