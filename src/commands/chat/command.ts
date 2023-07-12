import { Conversation } from "@lazuee/poe.js";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	Message,
	ThreadAutoArchiveDuration,
} from "discord.js";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { SetIntervalAsyncTimer, clearIntervalAsync, setIntervalAsync } from "set-interval-async";

import { detectLanguage, setActive } from ".../utils";
import Command from "../../structures/command";
import commands from "../../structures/store/command";
import { send_message } from "./poe";

const messagesClient: Record<
	string,
	{ history: Conversation[]; message_ids: string[]; intervalId?: SetIntervalAsyncTimer<[]> }
> = {};

const loading = "<a:loading:1118947021508853904>";
const maxLength = 1200;

export default new Command("gpt", "Ask me anything")
	.setExecutor({
		message: async function (message) {
			if (message.args![0] !== "SETUP") return;
			const embed = new EmbedBuilder()
				.setDescription("Click the button below to start asking questions.")
				.setColor("#2f3136");
			const button = new ButtonBuilder()
				.setCustomId("gpt-thread")
				.setLabel("Start")
				.setStyle(ButtonStyle.Success);
			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

			await message.channel.send({ content: "", embeds: [embed], components: [row] });
		},
		button: async function (interaction) {
			if (!interaction.channel?.isTextBased()) return;

			switch (interaction.customId.split("-").at(-1)) {
				case "thread":
					{
						if (!("threads" in interaction.channel)) return;
						const thread = interaction.channel.threads.cache.find(
							(x) => x.name === interaction.user.username,
						);
						if (thread) {
							if (thread.joinable) await thread.join();
							await thread.setRateLimitPerUser(3);
							const member = (await thread.members.fetch()).find((x) => x.id === interaction.user.id);
							if (member) {
								thread.send(`<@${interaction.user.id}>`).then((x) => x.delete());

								await interaction.reply({
									content: `You've already thread! Please use <#${thread.id}>`,
									ephemeral: true,
								});
								return;
							} else await thread.delete();
						}

						const thread_start = await interaction.channel.threads.create({
							name: interaction.user.username,
							autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
							//@ts-ignore
							type: ChannelType.PrivateThread,
						});

						if (thread_start.joinable) await thread_start.join();
						await thread_start.setRateLimitPerUser(3);
						const msg = await thread_start.send(`Hello, coder!\n\nAsk me anything related to programming.`);
						await msg.pin();
						await thread_start.members.add(interaction.user.id);

						await interaction.reply({
							content: `You've created a thread! <#${thread_start.id}>`,
							ephemeral: true,
						});
					}
					break;
				default:
					return;
			}
		},
	})
	.useEvent({
		name: "messageReactionAdd",
		once: false,
		execute: async function (reaction, user) {
			if (user.bot) return;
			if (reaction.message.partial) await reaction.message.fetch();
			if (
				reaction.message.reactions.cache.find(
					(r) => r.emoji.name === reaction.emoji.name && !r.users.cache.has(reaction.client.user.id),
				)
			)
				return;

			const data = Object.values(messagesClient).find(({ message_ids }) =>
				message_ids.includes(reaction.message.id),
			);
			const key = Object.entries(messagesClient).find(([_, value]) => value === data)?.[0] ?? "";
			if (!data) return;

			switch (reaction.emoji.toString()) {
				case "🔁": {
					const intervalId = data?.intervalId;
					if (intervalId) {
						await clearIntervalAsync(intervalId);
						delete messagesClient[key].intervalId;
					}

					const message = await reaction.message.channel.messages.cache
						.get(data.message_ids[0]!)!
						.fetchReference();

					for (const message_id of data.message_ids)
						await reaction.message.channel.messages.cache.get(message_id)?.delete();

					chat(message, data.history, key);
					return;
				}
				case "❌": {
					const intervalId = data?.intervalId;
					if (intervalId) {
						await clearIntervalAsync(intervalId);
						delete messagesClient[key].intervalId;

						const message = reaction.message.channel.messages.cache.get(data.message_ids.at(-1)!);
						await message?.edit(message.content.replace(loading, "").replace(/[ \t\r\n]+$/g, ""));
						await message?.reactions.cache.get("❌")?.remove();
					}
					return;
				}
				default:
					break;
			}
		},
	})
	.useEvent({
		name: "messageCreate",
		once: false,
		execute: async function (message) {
			if (!message.channel.isThread()) return;
			if (message.system || message.author.bot) return;
			if (message.isClientMention) message.content = `${message.commandName} ${message.args.join(" ")}`;
			if ([...commands.values()].some((command) => command.isTriggered((name) => name === message.commandName)))
				return;

			const key = String.fromCharCode(Math.floor(Math.random() * 26) + 97) + Date.now().toString();
			const history = await getHistory(message);
			messagesClient[key] = {
				history,
				message_ids: [],
			};

			chat(message, history, key);
		},
	});

async function getHistory(message: Message, conversation: Conversation[] = []): Promise<Conversation[]> {
	if (conversation.length <= 25) {
		const regex = new RegExp(`^(@${message.client.user.username})`, "g");
		let content = message.cleanContent.replace(regex, "").trim();

		if (content.length <= 0 && message.embeds?.[0] && message.author.id === message.client.user.id)
			content = message.embeds[0].description ?? "";

		if (content.length <= 0) content = "^ see last message in conversation history.";
		conversation.push({
			role: message.author.bot ? "model" : "user",
			content,
			name: message.author.username,
		});

		const reply = await message.fetchReference().catch(() => null);
		if (reply) return await getHistory(reply, conversation);
	}

	return conversation.reverse();
}

async function chat(message: Message, history: Conversation[], key: string) {
	const __dirname = dirname(new URL(import.meta.url).pathname);
	const prompt = await readFile(join(__dirname, "prompt.md"), "utf8");
	const conversation: Conversation[] = [
		{
			role: "system",
			content: prompt.replaceAll(/bot_name/g, message.client.user.username),
		},
	];

	const addCodeLanguage = async (content: string) => {
		const regex = /`{3}([\S]+)?\n([\s\S]*?)\n`{3}/g;
		let match = regex.exec(content);

		while (match !== null) {
			const [codeblock, prefix, code] = match;
			if (prefix) {
				match = regex.exec(content);
				continue;
			}

			const newPrefix = await detectLanguage(code);
			const newCodeBlock = codeblock.replace(/`{3}([\S]+)?\n/, "```" + newPrefix + "\n");
			content = content.slice(0, match.index) + newCodeBlock + content.slice(match.index + match[0].length);

			match = regex.exec(content);
		}

		return content;
	};
	const formatContent = async (content: string) => {
		content = await addCodeLanguage(content);
		content = content.replace(/([\n\r]{2,})(?=[^\n\r]*```[\s\S]*?```)|([\n\r]{2,})(?=[^\n\r])/g, "\n");

		return content;
	};
	const editMessage = async (content: string, isLoading = true) => {
		content = await formatContent(content);
		content += isLoading ? " " + loading : "";
		await message.channel.messages.cache.get(messagesClient[key].message_ids.at(-1)!)?.edit(content);
	};
	const sendMessage = async (content: string, isLoading = true) => {
		content = await formatContent(content);
		content += isLoading ? " " + loading : "";
		const _message = await message.channel.send(content);
		messagesClient[key].message_ids.push(_message.id);
	};
	const _message = await message.reply(loading + "ㅤ");
	await _message?.react("🔁");
	await _message?.react("❌");

	messagesClient[key].message_ids = [];
	messagesClient[key].message_ids.push(_message.id);

	let nextText: string | null = null;
	let currentText = "";
	messagesClient[key].intervalId = setIntervalAsync(async () => {
		if (nextText === null) return;
		if (nextText?.length) {
			if (currentText.endsWith(nextText)) return;
			currentText += nextText;
			nextText = "";

			let content = currentText.replace(/[ \t\r\n]+$/g, "");
			const lastCodeblock = content.match(/`{3}([\S]+)?\n([\s\S]*?)(?:\n`{3}|$)/g)?.pop() ?? null;
			const noClosingCodeblock = lastCodeblock?.match(/`{3}/g)?.length === 1;
			const lastLine =
				content
					?.split("\n")
					?.filter((x) => x.length)
					?.pop() ?? "";

			if (noClosingCodeblock) content = content + "\n```";

			if (content.length >= maxLength) {
				await message.channel.messages.cache
					.get(messagesClient[key].message_ids.at(-1)!)
					?.reactions?.removeAll();
				if (noClosingCodeblock && !/^`{3}/.test(content.trim())) {
					const prevContent = content.substring(0, content.indexOf(lastCodeblock));
					await editMessage(prevContent, false);
					const nextContent = content.substring(content.indexOf(lastCodeblock));
					currentText = currentText.substring(currentText.indexOf(lastCodeblock));
					await sendMessage(nextContent);
				} else {
					const prevContent = content.substring(0, content.indexOf(lastLine));
					if (prevContent.length <= 0) return console.log(content);
					await editMessage(prevContent, false);
					const nextContent = content.substring(content.indexOf(lastLine));
					currentText = currentText.substring(currentText.indexOf(lastLine));
					await sendMessage(nextContent);
				}

				const _message = message.channel.messages.cache.get(messagesClient[key].message_ids.at(-1)!);
				await _message?.react("🔁");
				await _message?.react("❌");
			} else await editMessage(content);
		} else {
			await clearIntervalAsync(messagesClient[key].intervalId!);
			delete messagesClient[key].intervalId;

			await editMessage(currentText, false);
			const _message = message.channel.messages.cache.get(messagesClient[key].message_ids.at(-1)!);
			await _message?.reactions.cache.get("❌")?.remove();

			const _message_id = messagesClient[key].message_ids.at(-1);
			setTimeout(
				() => {
					const __message_id = messagesClient[key].message_ids.at(-1)!;
					if (_message_id !== __message_id) return;

					message.channel.messages.cache.get(__message_id)?.reactions?.removeAll();
					delete messagesClient[key];
				},
				3 * 60 * 1000,
			);
		}
	}, 1000);

	setActive(message.client);
	await send_message(conversation.concat(history), {
		withChatBreak: true,
		onRunning: () => {},
		onTyping: async (msg) => {
			if (typeof nextText !== "string") nextText = "";
			nextText += msg.text_new;

			await new Promise((resolve) => setTimeout(resolve, 200));
		},
	});
}
