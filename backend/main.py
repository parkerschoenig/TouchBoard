"""TouchBoard server: serves the static frontend and the REST + SSE API."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .api.routes import router as api_router
from .poller import poller

FRONTEND = Path(__file__).parent.parent / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    poller.start()
    yield
    await poller.stop()


app = FastAPI(title="TouchBoard", lifespan=lifespan)
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
