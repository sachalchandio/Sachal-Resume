import os
import sys

import pytest

# Make the backend package importable when running pytest from anywhere.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app as flask_app  # noqa: E402


@pytest.fixture
def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()
