#!/usr/bin/env python3
"""
AI-Plugin local vector service.

This service keeps all embeddings and ChromaDB data on the local machine.
Node talks to it over 127.0.0.1 only.
"""

import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

# huggingface_hub reads HF_ENDPOINT during import in some versions, so set it
# before importing sentence-transformers/chromadb.
if "HF_ENDPOINT" not in os.environ:
    os.environ["HF_ENDPOINT"] = os.environ.get("AI_PLUGIN_HF_ENDPOINT", "https://hf-mirror.com")

import chromadb
from sentence_transformers import SentenceTransformer


CHROMA_DB_PATH = sys.argv[1] if len(sys.argv) > 1 else "./chroma_db"
SERVER_HOST = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
SERVER_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 9901
SERVER_VERSION = "2026-07-25.5"
MODEL_NAME = sys.argv[4] if len(sys.argv) > 4 else os.environ.get(
    "AI_PLUGIN_VECTOR_MODEL",
    "shibing624/text2vec-base-chinese",
)
COLLECTION_NAME = os.environ.get("AI_PLUGIN_VECTOR_COLLECTION", "ai_memory")

embedding_model = None
chroma_client = None
collection = None
is_ready = False
init_error = ""
init_failed = False


def sanitize_metadata(metadata):
    clean = {}
    if not isinstance(metadata, dict):
        return clean
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            clean[str(key)] = value
        else:
            clean[str(key)] = json.dumps(value, ensure_ascii=False)
    return clean


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def write_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except BrokenPipeError:
        print("Client disconnected before response could be sent", flush=True)


def compact_error(exc):
    return f"{type(exc).__name__}: {exc}"


def coerce_text(value):
    text = str(value if value is not None else "").strip()
    return text.replace("\x00", "")


def encode_texts_resilient(ids, texts):
    try:
        embeddings = embedding_model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        if hasattr(embeddings, "tolist"):
            embeddings = embeddings.tolist()
        return embeddings, []
    except Exception as exc:
        print(f"Batch embedding failed, falling back to single-item encode: {compact_error(exc)}", flush=True)

    embeddings = []
    failures = []
    for index, text in enumerate(texts):
        try:
            embeddings.append(get_embedding(text))
        except Exception as exc:
            failures.append({
                "id": ids[index] if index < len(ids) else "",
                "index": index,
                "error": compact_error(exc),
                "preview": text[:120],
            })
            embeddings.append(None)
    return embeddings, failures


def shutdown_after_init_failure(server):
    time.sleep(0.5)
    server.shutdown()


def init_model(server=None):
    global embedding_model, chroma_client, collection, is_ready, init_error, init_failed
    try:
        print(f"HuggingFace endpoint: {os.environ.get('HF_ENDPOINT', '')}", flush=True)
        print(f"Loading embedding model: {MODEL_NAME}", flush=True)
        embedding_model = SentenceTransformer(MODEL_NAME)
        test_embedding = get_embedding("AI-Plugin vector self test")
        print(f"Embedding model loaded, dimension={len(test_embedding)}", flush=True)

        print(f"Opening ChromaDB: {CHROMA_DB_PATH}", flush=True)
        chroma_client = chromadb.PersistentClient(path=CHROMA_DB_PATH)
        collection = chroma_client.get_or_create_collection(name=COLLECTION_NAME)
        is_ready = True
        print("Vector database ready", flush=True)
    except Exception as exc:
        init_failed = True
        init_error = compact_error(exc)
        print(f"Vector database init failed: {init_error}", flush=True)
        print(traceback.format_exc(), flush=True)
        if server is not None:
            threading.Thread(target=shutdown_after_init_failure, args=(server,), daemon=True).start()


def reset_collection():
    global collection
    try:
        chroma_client.delete_collection(name=COLLECTION_NAME)
    except Exception:
        pass
    collection = chroma_client.get_or_create_collection(name=COLLECTION_NAME)


def get_embedding(text):
    embedding = embedding_model.encode(coerce_text(text), normalize_embeddings=True, show_progress_bar=False)
    if hasattr(embedding, "tolist"):
        embedding = embedding.tolist()
    if isinstance(embedding, list) and embedding and isinstance(embedding[0], list):
        return embedding[0]
    return embedding


class VectorDBHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            if self.path == "/health":
                self.handle_health()
            elif self.path == "/stats":
                self.handle_stats()
            else:
                write_json(self, 404, {"error": "not found"})
        except Exception as exc:
            self.handle_exception(exc)

    def do_POST(self):
        try:
            if self.path == "/health":
                self.handle_health()
            elif self.path in ("/add", "/upsert"):
                self.handle_add()
            elif self.path in ("/add_many", "/upsert_many"):
                self.handle_add_many()
            elif self.path == "/search":
                self.handle_search()
            elif self.path == "/delete":
                self.handle_delete()
            elif self.path == "/delete_where":
                self.handle_delete_where()
            elif self.path == "/stats":
                self.handle_stats()
            elif self.path == "/reset":
                self.handle_reset()
            else:
                write_json(self, 404, {"error": "not found"})
        except Exception as exc:
            self.handle_exception(exc)

    def handle_exception(self, exc):
        if isinstance(exc, BrokenPipeError):
            print("Client disconnected during request handling", flush=True)
            return
        error = compact_error(exc)
        print(f"Request failed: {error}", flush=True)
        print(traceback.format_exc(), flush=True)
        try:
            write_json(self, 500, {"success": False, "error": error})
        except Exception:
            pass

    def handle_health(self):
        write_json(self, 200, {
            "ready": is_ready,
            "failed": init_failed,
            "error": init_error,
            "model": MODEL_NAME,
            "collection": COLLECTION_NAME,
            "server_version": SERVER_VERSION,
            "path": CHROMA_DB_PATH,
            "endpoint": os.environ.get("HF_ENDPOINT", ""),
        })

    def handle_stats(self):
        if not self._ensure_ready():
            return
        try:
            count = collection.count()
            write_json(self, 200, {
                "success": True,
                "ready": True,
                "count": count,
                "model": MODEL_NAME,
                "collection": COLLECTION_NAME,
                "server_version": SERVER_VERSION,
                "path": CHROMA_DB_PATH,
            })
        except Exception as exc:
            write_json(self, 500, {"success": False, "error": str(exc)})

    def _ensure_ready(self):
        if is_ready:
            return True
        write_json(self, 503, {"error": init_error or "service not ready"})
        return False

    def handle_add(self):
        if not self._ensure_ready():
            return
        data = read_json(self)
        doc_id = str(data.get("id", "")).strip()
        text = coerce_text(data.get("text", ""))
        if not doc_id or not text:
            write_json(self, 400, {"error": "id and text are required"})
            return
        metadata = sanitize_metadata(data.get("metadata", {}))
        embedding = get_embedding(text)
        collection.upsert(ids=[doc_id], embeddings=[embedding], documents=[text], metadatas=[metadata])
        write_json(self, 200, {"success": True, "count": 1})

    def handle_add_many(self):
        if not self._ensure_ready():
            return
        data = read_json(self)
        docs = data.get("documents", [])
        ids = []
        texts = []
        metadatas = []
        for item in docs:
            if not isinstance(item, dict):
                continue
            doc_id = str(item.get("id", "")).strip()
            text = coerce_text(item.get("text", ""))
            if not doc_id or not text:
                continue
            ids.append(doc_id)
            texts.append(text)
            metadatas.append(sanitize_metadata(item.get("metadata", {})))
        if not ids:
            write_json(self, 200, {"success": True, "count": 0})
            return
        embeddings, failures = encode_texts_resilient(ids, texts)
        ok_ids = []
        ok_texts = []
        ok_metadatas = []
        ok_embeddings = []
        for index, embedding in enumerate(embeddings):
            if embedding is None:
                continue
            ok_ids.append(ids[index])
            ok_texts.append(texts[index])
            ok_metadatas.append(metadatas[index])
            ok_embeddings.append(embedding)
        if ok_ids:
            collection.upsert(ids=ok_ids, embeddings=ok_embeddings, documents=ok_texts, metadatas=ok_metadatas)
        if failures:
            print(f"Skipped {len(failures)} embedding document(s): {json.dumps(failures[:5], ensure_ascii=False)}", flush=True)
        write_json(self, 200, {
            "success": len(ok_ids) > 0,
            "count": len(ok_ids),
            "failed": len(failures),
            "failures": failures[:5],
        })

    def handle_search(self):
        if not self._ensure_ready():
            return
        data = read_json(self)
        query = str(data.get("query", "")).strip()
        limit = max(1, min(int(data.get("limit", 10) or 10), 80))
        where = data.get("where")
        if not query:
            write_json(self, 200, {"results": []})
            return
        query_embedding = get_embedding(query)
        kwargs = {
            "query_embeddings": [query_embedding],
            "n_results": limit,
            "include": ["documents", "metadatas", "distances"],
        }
        if isinstance(where, dict) and where:
            kwargs["where"] = sanitize_metadata(where)
        results = collection.query(**kwargs)
        formatted = []
        ids = results.get("ids", [[]])[0] or []
        docs = results.get("documents", [[]])[0] or []
        metas = results.get("metadatas", [[]])[0] or []
        distances = results.get("distances", [[]])[0] or []
        for index, doc_id in enumerate(ids):
            formatted.append({
                "id": doc_id,
                "text": docs[index] if index < len(docs) else "",
                "metadata": metas[index] if index < len(metas) else {},
                "distance": distances[index] if index < len(distances) else 0,
            })
        write_json(self, 200, {"results": formatted})

    def handle_delete(self):
        if not self._ensure_ready():
            return
        data = read_json(self)
        ids = [str(item) for item in data.get("ids", []) if str(item).strip()]
        if ids:
            collection.delete(ids=ids)
        write_json(self, 200, {"success": True, "count": len(ids)})

    def handle_delete_where(self):
        if not self._ensure_ready():
            return
        data = read_json(self)
        where = data.get("where")
        if not isinstance(where, dict) or not where:
            write_json(self, 400, {"error": "where is required"})
            return
        collection.delete(where=sanitize_metadata(where))
        write_json(self, 200, {"success": True})

    def handle_reset(self):
        if not self._ensure_ready():
            return
        try:
            reset_collection()
            write_json(self, 200, {"success": True, "count": collection.count()})
        except Exception as exc:
            write_json(self, 500, {"success": False, "error": str(exc)})

    def log_message(self, _format, *args):
        return


class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True


def main():
    os.makedirs(CHROMA_DB_PATH, exist_ok=True)
    server = ReusableHTTPServer((SERVER_HOST, SERVER_PORT), VectorDBHandler)
    print(f"HTTP server listening at http://{SERVER_HOST}:{SERVER_PORT}, version={SERVER_VERSION}", flush=True)
    threading.Thread(target=init_model, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
