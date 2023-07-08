import { Poe } from "@lazuee/poe.js";

const tokens = process.env["POE_TOKENS"]?.split("|")?.filter((x) => typeof x === "string" && x.length > 5) ?? [];

export const poes = new Map<string, Poe>();

export const initialize = async () => {
	for (const token of tokens) {
		const poe = new Poe({
			token,
			displayName: "Sage",
		});

		console.clear();
		console.info(`Initializing Poe${".".repeat(tokens.indexOf(token) + 1)}`);
		try {
			await poe.initialize();
			poes.set(token, poe);
		} catch (_) {}
	}
};

export const send_message: Poe["send_message"] = async (...args) => {
	const sortedPoes = [...poes.values()].sort((a, b) => a.pendingCount - b.pendingCount);

	for (const poe of sortedPoes) {
		if (!poe.pendingCount) {
			try {
				const result = await poe.send_message(...args);
				return result;
			} catch (error) {
				throw error;
			}
		}
	}

	for (const poe of sortedPoes) {
		try {
			const result = await poe.send_message(...args);
			return result;
		} catch (error) {
			throw error;
		}
	}

	throw new Error("No poe has been settled");
};
