"""Shared pytest fixtures."""
import pytest

import retrace.recorder as _recorder


@pytest.fixture(autouse=True)
def _reset_shared_transport():
    """The recorder caches a module-level shared transport, so without a reset the per-test
    `@patch("retrace.recorder.create_transport")` only takes effect for the first test to
    create a recorder. Reset it around every test so each test gets its own (mocked) transport.
    """
    _recorder._shared_transport = None
    yield
    _recorder._shared_transport = None
