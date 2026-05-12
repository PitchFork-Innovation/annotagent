import { MongoClient } from "mongodb";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

const client = new MongoClient(env.MONGODB_URI);

const clientPromise: Promise<MongoClient> =
  global._mongoClientPromise ?? (global._mongoClientPromise = client.connect());

export default clientPromise;
