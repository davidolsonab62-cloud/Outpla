from pymongo import MongoClient

LOCAL_URI = "mongodb://localhost:27017"
LIVE_URI = "mongodb+srv://davidolsonab62_db_user:YT4OnJxRcKnESlPg@stakechess.fpwcdar.mongodb.net/?appName=StakeChess"          # your Atlas connection string
LIVE_DB_NAME = "StakeChess"  # your live DB name

local_client = MongoClient(LOCAL_URI)
live_client = MongoClient(LIVE_URI)
live_db = live_client[LIVE_DB_NAME]

source_dbs = ["stakechess", "sttakechess"]
collections = ["games", "tournaments"]

for db_name in source_dbs:
    source_db = local_client[db_name]
    for coll_name in collections:
        docs = list(source_db[coll_name].find({}))
        if not docs:
            print(f"{db_name}.{coll_name}: nothing to migrate")
            continue
        for doc in docs:
            doc.pop("_id", None)
        result = live_db[coll_name].insert_many(docs)
        print(f"{db_name}.{coll_name}: migrated {len(result.inserted_ids)} docs")

print("Done.")
