import { PermissionsBitField, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { storeMessage, getRoomHistory, getCampaignSummary, markOldestMessagesAsDeleted, getCharacterProfiles, storeCampaignSummary, storeCharacterProfile, initRAGApplication } from '../database.js';
import axios from 'axios';
import AnthropicClient from '@anthropic-ai/sdk';

const rollDice = (diceNotation) => {
  const [num, sides] = diceNotation.split('d').map(Number);
  let total = 0;
  for (let i = 0; i < num; i++) {
      total += Math.floor(Math.random() * sides) + 1;
  }
  return total;
};

const replaceDiceRolls = (messageContent) => {
  return messageContent.replace(/\b(\d+d\d+)\b/g, (match) => rollDice(match));
};

export const handleDndMessage = async (message, roomId, userId, client) => {
  const ignoredKeywords = ['aside', 'earmuffs', 'gmignore'];
  if (ignoredKeywords.some(keyword => message.content.toLowerCase().includes(keyword))) {
    console.log(`Ignoring message from ${message.author.id} in channel ${message.channel.id} due to ignored keyword.`);
    return;
  }

  try {
    console.log(`Received message from ${message.author.id} in channel ${message.channel.id}: ${message.content}`);
    const processedContent = replaceDiceRolls(message.content);

    if (message.content.toLowerCase() === 'retry') {
      console.log(`Received 'retry' message from ${message.author.id} in channel ${message.channel.id}. Continuing execution without saving.`);
    } else {
      await storeMessage(roomId, userId, 'user', processedContent);
    }

    const roomHistory = await getRoomHistory(roomId);
    console.log(`Updated room history for room ${roomId}. Current history length: ${roomHistory.length}`);

    const permissions = message.channel.permissionsFor(client.user);
    if (!permissions || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
      console.log(`Bot does not have permission to send messages in channel ${roomId}`);
      return;
    }

    console.log('Initializing RAG Application for message processing...');
    const ragApplication = await initRAGApplication(roomId, { loadMonsterManual: true, loadPlayersHandbook: true });

    if (roomHistory.length % 10 === 0 && roomHistory.length > 10) {
      console.log('Room history length is a multiple of 10, generating summary...');
      const currentSummary = await getCampaignSummary(roomId);
      const oldestMessages = roomHistory.slice(0, 10);
      const summaryPrompt = `
              You are a note taker for a table top role playing game where the previous summary was as follows:
              ${currentSummary}
              Summarize the following messages along with the current summary so the GM can continue the campaign from your notes.
              Only summarize the current campaign state. Do not include character states.

              Here is what happened since the last summary was generated:
              ${oldestMessages.map(msg => `@${msg.userId}: ${msg.content}`).join('\n')}
          `;
      const summaryResponse = await ragApplication.query(summaryPrompt);
      await storeCampaignSummary(roomId, summaryResponse.content);
      console.log(`\n\n\nCampaign Summary for Room ${roomId}:\n${summaryResponse.content}\n\n`);
      console.log(`Updated campaign summary for room ${roomId}.`);

      await markOldestMessagesAsDeleted(roomId, 10);
      console.log('Marked the 10 oldest messages as deleted in room history.');
    }

    const unprocessedMessages = await getRoomHistory(roomId);
    let campaignSummary = await getCampaignSummary(roomId);

    // Count tokens in the summary
    const tokenCount = campaignSummary.split(/\s+/).length;

    // If the token count exceeds 10000, attempt a summary reduction
    if (tokenCount > 10000) {
      console.log('Campaign summary exceeds 10000 tokens, attempting summary reduction...');
      const summaryReductionPrompt = `
              You are a note taker for a table top role playing game. The current summary is too long:
              ${campaignSummary}
              Please reduce the summary by removing the oldest part of the history while maintaining GM instructions and character info. Convert detailed summary info into concise rough history where possible.
          `;
      const summaryReductionResponse = await ragApplication.query(summaryReductionPrompt);
      campaignSummary = summaryReductionResponse.content;
      await storeCampaignSummary(roomId, campaignSummary);
      console.log('Campaign summary reduced and updated.');
    }

    const characterProfiles = await getCharacterProfiles(roomId);
    const characterProfileStrings = characterProfiles.map(profile => profile.characterData).join('\n\n');


    const anthropicClient = new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Determine the current operation mode
    const determineOperationMode = async () => {
      const recentMessages = unprocessedMessages.slice(-10).map(msg => `@${msg.userId}: ${msg.content}`).join('\n');
      const modePrompt = `
              You are a GM running a D&D 5th edition campaign. Based on the following recent messages, determine the current operation mode:
              ${recentMessages}
              The modes are:
              1. setup: Characters are not yet set up and the campaign has not started.
              2. exploration: Activities that are not during a combat encounter.
              3. combat: Ensuring all characters act before continuing with the campaign description.
              Respond with only the mode name: setup, exploration, or combat.

              Here are the character profiles:
              ${characterProfiles.map(profile => profile.characterData).join('\n\n')}
              after the operation mode output --rules-- followed by any rules that are appropriate for the situation from our rulebook.
          `;
      const [modeResponse, rules] = (await ragApplication.query(modePrompt)).content.split('--rules--');
      return [modeResponse.trim(), rules.trim()];
    };

    const [operationMode, rules] = await determineOperationMode();

    let systemMessage;
    let userMessages = [];

    if (operationMode === 'setup') {
      systemMessage = `
            The campaign is in setup mode.
            ${characterProfiles.length > 0 ? `Here are the character profiles:\n${characterProfileStrings}` : 'No character profiles are provided. Please ensure all character profiles are available before starting the campaign.'}
            Encourage the players to set up their characters and provide any necessary rules for setup.
        `;
    } else if (operationMode === 'exploration') {
      systemMessage = `
            The campaign is in exploration mode.
            ${characterProfiles.length > 0 ? `Here are the character profiles:\n${characterProfileStrings}` : 'No character profiles are provided. Please ensure all character profiles are available before starting the campaign.'}
            Continue the campaign with appropriate rules for exploration activities.

            1. Stay in character as DM.
            2. When I tell you what I do, describe what happens briefly but colorfully.
            3. Your description ends when it is unclear what my character should do next.
            4. NEVER make choices for me, and NEVER finish until there is a choice for me to make.
            5. NEVER describe options or ask questions, as it breaks immersion. That goes especially for open-ended questions, thought provoking questions, etc.
            6. ALWAYS determine what 5e rules apply by looking up what is happening in the documents and retrieving relevant rules.
            7. Once you have determined which rules apply, ALWAYS ask the players to roll.
            8. When a user rolls you must must ALWAYS include the DC or AC, and print exactly what happens for a natural 20,  success,  failure, and critical failure. You users will also roll dice for damage.
            These 8 rules are sacrosanct. Follow them for EVERY reply.
            If I suggest something prevented by the rules, such as casting a spell that I do not have on my character sheet, explain why I cannot and prompt me again.
        `;
    } else if (operationMode === 'combat') {
      systemMessage = `
            The campaign is in combat mode.
            ${characterProfiles.length > 0 ? `Here are the character profiles:\n${characterProfileStrings}` : 'No character profiles are provided. Please ensure all character profiles are available before starting the campaign.'}
            Ensure all characters have a chance to act before continuing with the campaign description.
            Output your continuation message asking for any dice rolls required by the D&D 5th edition rules.

            1. Stay in character as DM.
            2. When I tell you what I do, describe what happens briefly but colorfully.
            3. Your description ends when it is unclear what my character should do next.
            4. NEVER make choices for me, and NEVER finish until there is a choice for me to make.
            5. NEVER describe options or ask questions, as it breaks immersion. That goes especially for open-ended questions, thought provoking questions, etc.
            6. ALWAYS determine what 5e rules apply by looking up what is happening in the documents and retrieving relevant rules.
            7. Once you have determined which rules apply, ALWAYS ask the players to roll.
            8. When a user rolls you must must ALWAYS include the DC or AC, and print exactly what happens for a natural 20,  success,  failure, and critical failure. You users will also roll dice for damage.
            These 8 rules are sacrosanct. Follow them for EVERY reply.
            If I suggest something prevented by the rules, such as casting a spell that I do not have on my character sheet, explain why I cannot and prompt me again.

            Combat rules:
            1. At the start of combat, roll initiative. Create an "encounter yaml" structure with the initiative order, and the enemies' stats, including AC, HP, attacks, to-hit bonus, and damage.
            2. Update it each round.
            3. Each round, ask me what I do. Then take EACH enemy's action rolling dice appropriately, in initiative order.
            4. Before you are done with your reply, you must comprehensively update the encounter yaml and the player yaml if anything has changed such as HP totals etc.
            Violent death, both monster and pc, is expected and ok.
            When something happens to the character, update the character yaml.
            We have held a Session 0 and determined that nothing is off limits.
            Each time you reply, something interesting and novel should happen.
        `;
    }

    userMessages.push({
      role: 'user',
      content: 'summarize the campaign up to this point',
    });

    let lastMessage = {
      role: 'assistant',
      content: `${campaignSummary || 'No campaign summary has been generated yet.'} the following rules apply to the current situation ${rules}`,
    };

    userMessages.push(lastMessage);

    unprocessedMessages.filter(msg => msg.content.trim() !== '').forEach((msg, index) => {
      const currentRole = msg.role === 'user' ? 'user' : 'assistant';
      const userId = msg.userId === client.userId ? 'bot' : msg.userId;
      const content = `@${userId}: ${msg.content}`;

      if (currentRole === lastMessage.role) {
        lastMessage.content += `\n${content}`;
      } else {
        lastMessage = {
          role: currentRole,
          content,
        }
        userMessages.push(lastMessage)
      }
    });


    console.log(operationMode, systemMessage, userMessages);

    console.log('Querying Claude model with campaign prompt...');
    const campaignResponse = await anthropicClient.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      system: systemMessage,
      messages: userMessages,
      max_tokens: 1000
    });
    console.log('Campaign response received:', campaignResponse);

    const [textResponse, imageDescription] = campaignResponse.content[0].text.split('IMAGE:');

    if (textResponse.trim() !== 'CONTINUE') {
      console.log('Sending campaign response to channel...');
      const chunks = textResponse.match(/[\s\S]{1,2000}/g) || [];
      for (const chunk of chunks) {
        await message.channel.send(chunk.trim());
      }
      await storeMessage(roomId, client.user.id, 'agent', textResponse.trim());
      console.log('Campaign response sent and added to room history.');
    }


    try {
      const situationSummary = userMessages.map(msg => msg.content).join(' ');
      const dmResponse = textResponse.trim();
      let imageGenerationPrompt = `
              Generate a prompt describing an im image based on the following situation summary and DM response:
              Situation Summary: ${situationSummary}
              DM Response: ${dmResponse}

              The prompt should be written like comma separated set of phrases, use descriptors and styles but don't use flowery language.
              You can use parentheses followed by a number ex:(phrase)1.2 where the thing is something you want to emphasize and the number is between 1.1 and 2.0 level of emphasis
              You can add ++ which squares the importance or +++ to cube it
          `;

      if (operationMode === 'battle') {
        imageGenerationPrompt += 'The image shoule use a battle map style if it makes sense for the current situation.';
      } else {
        imageGenerationPrompt += 'The image should be clear and detailed, highlighting an aspect of the current situation.'
      }

      const ragImageResponse = await ragApplication.query(imageGenerationPrompt);
      const generatedImageDescription = ragImageResponse.content.trim();

      console.log('Generated image description:', generatedImageDescription);
      if (generatedImageDescription) {
        const [prompt, negativePrompt] = generatedImageDescription.split('NEGATIVE:');
        const response = await axios.post('http://192.168.1.178:7860/sdapi/v1/txt2img', {
          prompt: prompt.trim() + ' Anime art style <lora:1g0rXLP:1>',
          width: 1024,
          height: 1024, // Maintain aspect ratio
          steps: 25,
          negative_prompt: negativePrompt ? negativePrompt.trim() : ''
        });

        const imageBuffer = Buffer.from(response.data.images[0], 'base64');
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'generated_image.png' });

        const embed = new EmbedBuilder()
          .setImage('attachment://generated_image.png');

        console.log('Sending generated image to channel...');
        message.channel.send({ embeds: [embed], files: [attachment] });
        console.log('Generated image sent and added to room history.');
      } else {
        console.log('No image description generated by RAG application.');
      }
    } catch (error) {
      console.error('Error generating image using RAG application:', error);
    }


    // Handle character updates
    const characterUpdatePrompt = `
          You are a D&D 5e character generator. Here are the current character profiles:
          ${characterProfileStrings}
          Please update the character profiles based on the latest events: ${textResponse.trim()} and ensure they are formatted exactly like the 5e Monster Manual.
          Use the following format for each character:
          -- CHARACTER NAME --
          Character Name
          Size Type, Alignment
          Armor Class
          Hit Points
          Speed
          STR DEX CON INT WIS CHA
          Skills
          Senses
          Languages
          Challenge
          Traits
          Actions
          Biography
          PlayerID
      `;
    const characterUpdateResponse = await ragApplication.query(characterUpdatePrompt);
    const updatedCharacterProfiles = characterUpdateResponse.content.split('\n\n').map(profile => profile.trim());

    console.log('updating character profiles...', characterUpdateResponse);

    for (const updatedProfile of updatedCharacterProfiles) {
      const characterNameMatch = updatedProfile.match(/^-- (.*) --/);
      if (characterNameMatch) {
        const characterName = characterNameMatch[1].trim();
        const characterProfile = characterProfiles.find(profile => profile.characterName === characterName);
        if (characterProfile) {
          await storeCharacterProfile(roomId, characterProfile.userId, characterName, updatedProfile);
        }
      }
    }
  } catch (error) {
    console.error('Error processing message:', error);
    message.channel.send('OOPS I DONE GOOFED');
  }
}
