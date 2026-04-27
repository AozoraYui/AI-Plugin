#!/usr/bin/env python3
"""
AI-Plugin 向量数据库服务
使用 ChromaDB + text2vec-base-chinese 模型提供向量检索服务
"""

import sys
import os
import json
import chromadb
from sentence_transformers import SentenceTransformer
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

# 配置
CHROMA_DB_PATH = sys.argv[1] if len(sys.argv) > 1 else './chroma_db'
SERVER_HOST = '127.0.0.1'
SERVER_PORT = 9901
MODEL_NAME = 'shibing624/text2vec-base-chinese'

# 配置 HuggingFace 镜像（如果环境变量设置了）
HF_ENDPOINT = os.environ.get('HF_ENDPOINT', 'https://huggingface.co')
os.environ['HF_ENDPOINT'] = HF_ENDPOINT

# 全局变量
embedding_model = None
chroma_client = None
collection = None
is_ready = False

def init_model():
    """初始化向量模型和 ChromaDB"""
    global embedding_model, chroma_client, collection, is_ready
    
    print(f"Loading embedding model: {MODEL_NAME}...", flush=True)
    import io
    import contextlib
    
    stderr_capture = io.StringIO()
    with contextlib.redirect_stderr(stderr_capture):
        embedding_model = SentenceTransformer(MODEL_NAME, progress_bar=False)
    print("Embedding model loaded successfully", flush=True)
    
    print(f"Initializing ChromaDB at: {CHROMA_DB_PATH}", flush=True)
    chroma_client = chromadb.PersistentClient(path=CHROMA_DB_PATH)
    
    # 获取或创建集合
    try:
        collection = chroma_client.get_collection(name="ai_conversations")
        print("Loaded existing collection", flush=True)
    except:
        collection = chroma_client.create_collection(name="ai_conversations")
        print("Created new collection", flush=True)
    
    is_ready = True
    print("Vector database ready", flush=True)

def get_embedding(text):
    """获取文本向量"""
    return embedding_model.encode([text])[0].tolist()

class VectorDBHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理器"""
    
    def do_POST(self):
        if self.path == '/add':
            self.handle_add()
        elif self.path == '/search':
            self.handle_search()
        elif self.path == '/health':
            self.handle_health()
        else:
            self.send_error(404)
    
    def handle_health(self):
        """健康检查"""
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'ready': is_ready}).encode())
    
    def handle_add(self):
        """添加文档到向量数据库"""
        if not is_ready:
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Service not ready'}).encode())
            return
        
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        data = json.loads(body)
        
        doc_id = data['id']
        text = data['text']
        metadata = data.get('metadata', {})
        
        # 生成向量
        embedding = get_embedding(text)
        
        # 添加到 ChromaDB
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[text],
            metadatas=[metadata]
        )
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'success': True}).encode())
    
    def handle_search(self):
        """搜索相似文档"""
        if not is_ready:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'results': []}).encode())
            return
        
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        data = json.loads(body)
        
        query = data['query']
        limit = data.get('limit', 10)
        
        # 生成查询向量
        query_embedding = get_embedding(query)
        
        # 搜索
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=limit,
            include=['documents', 'metadatas', 'distances']
        )
        
        # 格式化结果
        formatted_results = []
        if results['ids'] and results['ids'][0]:
            for i, doc_id in enumerate(results['ids'][0]):
                formatted_results.append({
                    'id': doc_id,
                    'text': results['documents'][0][i],
                    'metadata': results['metadatas'][0][i],
                    'distance': results['distances'][0][i] if results['distances'] else 0
                })
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'results': formatted_results}).encode())
    
    def log_message(self, format, *args):
        """抑制默认日志"""
        pass

def main():
    """主函数"""
    # 先启动 HTTP 服务
    server = HTTPServer((SERVER_HOST, SERVER_PORT), VectorDBHandler)
    print(f"Server ready at http://{SERVER_HOST}:{SERVER_PORT}", flush=True)
    
    # 后台加载模型
    model_thread = threading.Thread(target=init_model, daemon=True)
    model_thread.start()
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down server...", flush=True)
        server.shutdown()

if __name__ == '__main__':
    main()
