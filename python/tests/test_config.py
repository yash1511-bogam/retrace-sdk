import os

def test_default_config():
    # Clear env and reset
    os.environ.pop("RETRACE_API_KEY", None)
    os.environ.pop("RETRACE_BASE_URL", None)
    import retrace.config as cfg
    cfg._config = None
    from retrace.config import get_config
    config = get_config()
    assert config.base_url == "http://localhost:3001"
    assert config.enabled == True

def test_configure():
    import retrace.config as cfg
    cfg._config = None
    from retrace.config import configure, get_config
    configure(api_key="rt_live_test", base_url="http://custom:3001")
    config = get_config()
    assert config.api_key == "rt_live_test"
    assert config.base_url == "http://custom:3001"
