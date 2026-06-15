"""API tests for the Flask backend."""


def test_portfolio_shape(client):
    res = client.get("/api/portfolio")
    assert res.status_code == 200
    data = res.get_json()
    for key in ("profile", "metrics", "capabilities", "projects", "experience", "stack", "education"):
        assert key in data
    assert data["profile"]["name"] == "Sachal Chandio"
    assert len(data["projects"]) == 4
    assert len(data["capabilities"]) == 4


def test_off_duty_shape(client):
    res = client.get("/api/off-duty")
    assert res.status_code == 200
    data = res.get_json()
    assert len(data["gaming"]) == 8
    assert len(data["anime"]) == 8
    # every anime carries exactly five quotes
    assert all(len(a["quotes"]) == 5 for a in data["anime"])
    assert len(data["berserk"]) == 5


def test_metrics_feed(client):
    res = client.get("/api/metrics")
    assert res.status_code == 200
    assert "metrics" in res.get_json()


def test_contact_valid(client):
    res = client.post(
        "/api/contact",
        json={"name": "Recruiter", "email": "r@co.com", "message": "We have a backend role for you."},
    )
    assert res.status_code == 200
    assert res.get_json()["ok"] is True


def test_contact_invalid_returns_field_errors(client):
    res = client.post("/api/contact", json={"name": "", "email": "bad", "message": "hi"})
    assert res.status_code == 400
    errors = res.get_json()["errors"]
    assert set(errors) == {"name", "email", "message"}


def test_health_and_ready(client):
    assert client.get("/healthz").get_json()["status"] == "ok"
    assert client.get("/readyz").get_json()["status"] == "ready"


def test_resume_is_pdf(client):
    res = client.get("/resume")
    assert res.status_code == 200
    assert res.mimetype == "application/pdf"


def test_unknown_route_returns_json_404(client):
    res = client.get("/api/nope")
    assert res.status_code == 404
    assert res.get_json()["error"] == "not_found"
