import detect from "@vscode/vscode-languagedetection";
import { Awaitable, Client, ClientEvents, Interaction, InteractionType, Message } from "discord.js";

import store from "../structures/store";

export const detectLanguage = async (code: string) => {
	const modulOperations = new detect.ModelOperations();
	const timeout = new Promise((resolve) => {
		setTimeout(() => resolve("timeout"), 1000);
	});
	const run = modulOperations.runModel(code);
	const result = (await Promise.race([timeout, run])) as detect.ModelResult[];

	return result[0]?.languageId ?? "";
};

export const splitMessage = (message: string, maxLength = 1800) => {
	const lines = message.split("\n");
	const chunks: string[][] = [];

	let currentChunk: string[] = [];
	for (const line of lines) {
		if (currentChunk.join("\n").length + line.length >= maxLength) {
			chunks.push(currentChunk);
			currentChunk = [];
		}
		currentChunk.push(line);
	}
	chunks.push(currentChunk);

	console.log(chunks.length);
	return chunks.map((chunk) => chunk.join("\n"));
};

export const setActive = (client: Client, active = true) => {
	if (client.user?.presence.status != "online" && active) {
		store.set("lastActive", Date.now());
		client.user?.setPresence({ status: "online" });
	} else if (client.user?.presence.status != "idle") client.user?.setPresence({ status: "idle" });
};

export const addListener = function <K extends keyof ClientEvents>(
	client: Client,
	event: K,
	listener: (...args: ClientEvents[K]) => Awaitable<any>,
	once = false,
) {
	if (!client) return;

	client[once ? "once" : "on"](event, async (...args) => {
		const message = args[0] as Message;
		const interaction = args[0] as Interaction;

		if (message instanceof Message) {
			const regex = new RegExp(`<[@]?${message.client.user?.id}+>`);

			message.isClientMention = false;

			if (message.mentions.repliedUser?.id === message.client.user?.id) {
				message.args = message.content.trim().split(/ +/g) as string[];
				message.commandName = message.args.shift()?.toLowerCase() ?? "";
				message.isClientMention = true;
			} else if (regex.test(message.content)) {
				const _args = message.content.replace(regex, "").trim().split(/ +/g) as string[];
				message.commandName = _args.shift()?.toLowerCase() ?? "";
				message.args = _args;
				message.isClientMention = true;
			}
			args[0] = message;
		}

		try {
			await listener?.call(client, ...args);
		} catch (error) {
			console.error(`An error occurred while calling the '${event}' listener`, { error });

			if (message instanceof Message) {
				message.reply({
					content: "An error occurred! Please try again later.",
				});
			} else {
				if (
					typeof interaction === "object" &&
					"inCachedGuild" in interaction! &&
					!interaction?.inCachedGuild()
				) {
					return;
				}

				//@ts-ignore
				switch (interaction?.type) {
					// Command
					case InteractionType.ApplicationCommand:
					case InteractionType.MessageComponent:
					case InteractionType.ModalSubmit:
						{
							if (!interaction.replied) {
								if (interaction.deferred) {
									interaction.editReply({
										content: "An error occurred! Please try again later.",
									});
								} else {
									interaction.reply({
										ephemeral: true,
										content: "An error occurred! Please try again later.",
									});
								}
							}
						}
						break;
					default:
						break;
				}
			}
		}
	});
};
