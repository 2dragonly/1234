import "dotenv/config";

import { initialize } from "./commands/chat/poe";
import Client from "./structures/client";

process.on("uncaughtException", (error) => {
	throw error;
	//console.error(`Uncaught Exception: ${error.message}`);
});
process.on("unhandledRejection", (error) => {
	throw error;
	//if (error instanceof Error) console.error(`Unhandled Rejection: ${error.message}`);
});

(async () => {
	await initialize();
	const client = new Client();
	client.start();
})();
