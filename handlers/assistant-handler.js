import { storeMessage, getRoomHistory, initRAGApplication } from '../database.js';
import { PermissionsBitField } from 'discord.js';

const USER_ID_FORMAT_INSTRUCTION = 'When responding to users format the response as <@userId> example <@376578314694819850>';

export const handleAssistantMessage = async (message, roomId, userId, client) => {
  if (!message.content.includes(`<@${client.userId}>`)) return;

  try {
    console.log(`Received message from ${message.author.id} in channel ${message.channel.id}: ${message.content}`);
    const processedContent = message.content.replace(`<@${client.userId}>`, '').trim();

    await storeMessage(roomId, userId, 'user', processedContent);

    const roomHistory = await getRoomHistory(roomId);
    console.log(`Updated room history for room ${roomId}. Current history length: ${roomHistory.length}`);

    const permissions = message.channel.permissionsFor(client.user);
    if (!permissions || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
      console.log(`Bot does not have permission to send messages in channel ${roomId}`);
      return;
    }

    console.log('Initializing RAG Application for message processing...');
    const ragApplication = await initRAGApplication(roomId, { loadMonsterManual: false, loadPlayersHandbook: false });

    const userMessages = roomHistory.map(msg => `<@${msg.userId}>: ${msg.content}`).join('\n');
    const prompt = `
      You are a helpful assistant. Respond in short order.
      If the query requires a specialist, respond with only the text 'specialist_id: <specialist_id>'.
      Repalce <specialist_id> with an id from this list of specialists:
      - code_specialist: For coding related queries.
      - travel_specialist: For travel related queries.
      - finance_specialist: For finance related queries.
      - health_specialist: For health related queries.
      - education_specialist: For education related queries.

      Here is the recent conversation history:
      ${userMessages}
      <@${userId}>: ${processedContent}

      ${USER_ID_FORMAT_INSTRUCTION}
    `;

    const response = await ragApplication.query(prompt);
    const responseText = response.content.trim();

    const regex = /specialist_id:\s*(\w+)/;
    if (responseText.match(regex)) {
      const specialistId = responseText.match(regex)[1];
      let specialistPrompt = '';
      console.log(`Utilizing specialist ${specialistId} for response...`);
      switch (specialistId) {
        case 'code_specialist':
          specialistPrompt = `
            You are a highly skilled code specialist with expertise in multiple programming languages, software architecture, and DevOps practices.
            An expert in this field should have deep knowledge of algorithms, data structures, design patterns, and modern development frameworks.
            Good experience: Architecting scalable, maintainable solutions; refactoring legacy code for improved performance; implementing robust CI/CD pipelines.
            Bad experience: Writing vulnerable code with security flaws; ignoring principles of clean code and documentation; failing to consider cross-platform compatibility.
            Query: ${processedContent}
            <@${userId}>: Respond to the query as a code specialist.

            ${USER_ID_FORMAT_INSTRUCTION}
          `;
          break;
        case 'travel_specialist':
          specialistPrompt = `
            You are a highly skilled travel specialist with extensive knowledge of global destinations, cultures, and travel logistics.
            An expert in this field should understand visa requirements, seasonal travel patterns, and how to craft unique experiences for diverse traveler types.
            Good experience: Curating off-the-beaten-path adventures; navigating complex multi-country itineraries; providing insider tips for immersive cultural experiences.
            Bad experience: Recommending cookie-cutter tour packages; overlooking potential travel restrictions or health advisories; disregarding travelers' personal interests and limitations.
            Query: ${processedContent}
            <@${userId}>: Respond to the query as a travel specialist.

            ${USER_ID_FORMAT_INSTRUCTION}
          `;
          break;
        case 'finance_specialist':
          specialistPrompt = `
            You are a highly skilled finance specialist with deep understanding of global markets, investment strategies, and economic trends.
            An expert in this field should be able to analyze complex financial data, understand regulatory environments, and provide sound advice for various financial goals.
            Good experience: Developing comprehensive wealth management strategies; explaining complex financial instruments in layman's terms; identifying emerging market opportunities.
            Bad experience: Offering one-size-fits-all investment advice; ignoring an individual's risk tolerance or time horizon; failing to disclose potential conflicts of interest.
            Query: ${processedContent}
            <@${userId}>: Respond to the query as a finance specialist.

            ${USER_ID_FORMAT_INSTRUCTION}
          `;
          break;
        case 'health_specialist':
          specialistPrompt = `
            You are a highly skilled health specialist with expertise in preventive care, nutrition, fitness, and holistic wellness approaches.
            An expert in this field should have a strong foundation in human biology, current medical research, and evidence-based health practices.
            Good experience: Creating personalized wellness plans integrating diet, exercise, and stress management; explaining complex medical concepts clearly; staying updated on the latest health research.
            Bad experience: Promoting pseudoscientific health claims; neglecting the importance of mental health in overall wellness; failing to recognize when to refer to medical professionals.
            Query: ${processedContent}
            <@${userId}>: Respond to the query as a health specialist.

            ${USER_ID_FORMAT_INSTRUCTION}
          `;
          break;
        case 'education_specialist':
          specialistPrompt = `
            You are a highly skilled education specialist with knowledge of diverse learning theories, educational technologies, and curriculum development.
            An expert in this field should understand cognitive development, inclusive education practices, and be able to adapt teaching methods for various learning needs.
            Good experience: Designing engaging, multi-modal learning experiences; implementing effective assessment strategies; fostering critical thinking and creativity in learners.
            Bad experience: Relying solely on standardized testing for evaluation; ignoring the importance of social-emotional learning; failing to adapt to diverse cultural and socioeconomic backgrounds.
            Query: ${processedContent}
            <@${userId}>: Respond to the query as an education specialist.

            ${USER_ID_FORMAT_INSTRUCTION}
          `;
          break;
        default:
          specialistPrompt = `
            You are a highly skilled assistant with broad knowledge across multiple disciplines.
            An expert assistant should be able to provide accurate, helpful information while recognizing the limits of their expertise.
            Query: ${processedContent}
            <@${userId}>: Respond to the query.

            ${USER_ID_FORMAT_INSTRUCTION}
          `;
      }

      const specialistResponse = await ragApplication.query(specialistPrompt);
      await message.channel.send(specialistResponse.content.trim());
    } else {
      await message.channel.send(responseText);
    }

    await storeMessage(roomId, client.user.id, 'assistant', responseText);
    console.log('Assistant response sent and added to room history.');
  } catch (error) {
    console.error('Error processing assistant message:', error);
    message.channel.send('OOPS I DONE GOOFED');
  }
};
