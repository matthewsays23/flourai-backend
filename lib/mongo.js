const { MongoClient } = require("mongodb");

let client;
let db;

async function connectMongo() {
  if (db) return db;

  client = new MongoClient(process.env.MONGO_URL);
  await client.connect();

  db = client.db(process.env.MONGO_DB_NAME || "flourai");
  console.log("MongoDB connected");
  return db;
}

async function getDb() {
  if (db) return db;
  return connectMongo();
}

module.exports = {
  connectMongo,
  getDb,
};