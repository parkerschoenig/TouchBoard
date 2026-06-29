"""TouchBoard server: serves the static frontend and the REST + SSE API."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .api.routes import router as api_router
from .demo import DEMO_MODE
from .poller import poller

FRONTEND = Path(__file__).parent.parent / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    if DEMO_MODE:
        from .demo.seed import seed
        seed()
    poller.start()
    yield
    await poller.stop()


app = FastAPI(title="TouchBoard", lifespan=lifespan)

if DEMO_MODE:
    @app.middleware("http")
    async def demo_guard(request: Request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS") and \
                not request.url.path.startswith("/api/auth/login"):
            return JSONResponse({"detail": "demo_mode"}, status_code=403)
        return await call_next(request)

app.include_router(api_router)


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.endswith((".js", ".css")):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response

app.add_middleware(NoCacheStaticMiddleware)


@app.get("/login")
def login_page():
    return FileResponse(FRONTEND / "login.html")


@app.get("/")
def home():
    return FileResponse(FRONTEND / "layout-editor.html")


@app.get("/configure")
def configure():
    return FileResponse(FRONTEND / "index.html")


@app.get("/display")
def display():
    return FileResponse(FRONTEND / "display.html")


@app.get("/favicon.ico")
def favicon():
    return FileResponse(FRONTEND / "static" / "img" / "favicon.ico")


@app.get("/healthz")
def healthz():
    return {"ok": True}


# static assets (css/js/vendor) under /static
app.mount("/static", StaticFiles(directory=FRONTEND / "static"), name="static")
