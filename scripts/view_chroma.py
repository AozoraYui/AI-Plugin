import chromadb
import sys

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else '/root/Yunzai/data/ai_assistant/chroma_db'

print(f"连接 ChromaDB: {DB_PATH}")
client = chromadb.PersistentClient(path=DB_PATH)

collections = client.list_collections()
print(f"\n共有 {len(collections)} 个集合")

for col in collections:
    print(f"\n{'='*60}")
    print(f"集合名称: {col.name}")
    
    count = col.count()
    print(f"文档总数: {count}")
    
    if count > 0:
        results = col.get(limit=10, include=['documents', 'metadatas'])
        print(f"\n最近 {min(10, count)} 条记录:")
        print(f"{'-'*60}")
        
        for i, (doc, meta) in enumerate(zip(results['documents'], results['metadatas'])):
            print(f"\n[{i+1}] ID: {results['ids'][i]}")
            print(f"    内容: {doc[:100]}{'...' if len(doc) > 100 else ''}")
            print(f"    元数据: {meta}")
