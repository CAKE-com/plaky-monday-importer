import { openDb } from "../src/db/client";
import { purgeFinished } from "../src/server/pipeline/purge";

const db = await openDb();
const erased = await purgeFinished(db);
db.$client.close();
console.log(erased ? `Every migration was finished: erased ${erased} from this computer.` : "Unfinished work, or nothing to erase: the data stays.");
