from fastapi import FastAPI, WebSocket

app = FastAPI()


@app.websocket("/ws/basket")
async def basket(ws: WebSocket):
    await ws.accept()
