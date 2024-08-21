import { storeMessage, getRoomHistory, initRAGApplication } from '../database.js';
import { PermissionsBitField } from 'discord.js';
import { generateImage } from '../imageGenerator.js';

const USER_ID_FORMAT_INSTRUCTION = 'When responding to users format the response as <@userId> example <@376578314694819850>';

export const handleAssistantMessage = async (message, roomId, userId, client) => {
  try {
    console.log(`Received message from ${message.author.id} in channel ${message.channel.id}: ${message.content}`);
    const processedContent = message.content.trim();

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
      Respond with only the text 'specialist_id: <specialist_id>'.
      Replace <specialist_id> with an id from this list of specialists:
      - code_specialist: For coding related queries.
      - travel_specialist: For travel related queries.
      - finance_specialist: For finance related queries.
      - health_specialist: For health related queries.
      - education_specialist: For education related queries.
      - image_generation_specialist: For generating images based on descriptions.
      - no_response: If the query doesn't require a response or is not something the bot can help with.

      Here is the most recent message:
      <@${userId}>: ${processedContent}

      If the most recent message indicates a continuation of a previous request, consider this additional context:
      ${userMessages}

      When determining the specialist, prioritize the content of the most recent message.
      Only use earlier messages if they provide necessary context for understanding the current request.
    `;

    const response = await ragApplication.query(prompt);
    const responseText = response.content.trim();

    const regex = /specialist_id:\s*(\w+)/;
    if (responseText.match(regex)) {
      const specialistId = responseText.match(regex)[1];
      
      if (specialistId === 'no_response') {
        console.log('No response required. Exiting.');
        return;
      }

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
        case 'image_generation_specialist':
          specialistPrompt = `
            You are a highly skilled image generation specialist. Your task is to create a detailed prompt for image generation based on the user's description.
            The prompt should be written as a comma-separated set of phrases, using descriptors and styles but avoiding flowery language.
            You can use parentheses followed by a number ex:(phrase)1.2 where the phrase is something you want to emphasize and the number is between 1.1 and 2.0 level of emphasis.
            You can add ++ which squares the importance or +++ to cube it.
            For negative features, use -- followed by the feature, e.g. "--ugly", to indicate elements that should not be included in the image.
            
            After creating the prompt, choose a random aspect ratio from the following options:
            1:1 (square), 4:3, 3:2, 16:9, 21:9 (ultrawide), 3:4 (portrait), 2:3 (portrait), 9:16 (portrait)
            
            Also, generate a random seed number between 0 and 4294967295.
            
            Query: ${processedContent}
            Respond with the image generation prompt, followed by the aspect ratio and seed on new lines, like this:
            [Your generated prompt here]
            aspectratio:[chosen aspect ratio]
            seed:[generated seed number]
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

      await message.channel.sendTyping();
      const specialistResponse = await ragApplication.query(specialistPrompt);
      
      if (specialistId === 'image_generation_specialist') {
        const imagePrompt = specialistResponse.content.trim();
        console.log('Generated image prompt:', imagePrompt);
        
        try {
          const [prompt, negativePrompt] = imagePrompt.split('NEGATIVE:');
          await message.channel.sendTyping();
          
          // Start a separate process to send typing indicator every 9 seconds
          const typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(console.error);
          }, 9000);
          
          const { embed, attachment } = await generateImage(prompt, negativePrompt);
          
          // Clear the typing interval
          clearInterval(typingInterval);
          
          console.log('Sending generated image to channel...');
          await message.channel.send({ embeds: [embed], files: [attachment] });
          console.log('Generated image sent to channel.');
          
          await storeMessage(roomId, client.user.id, 'assistant', `Image generated based on the following prompt: ${imagePrompt}`);
        } catch (error) {
          console.error('Error generating image:', error);
          await message.channel.send('Sorry, I encountered an error while generating the image.');
        }
      } else {
        await message.channel.send(specialistResponse.content.trim());
      }
    } else {
      await message.channel.send(responseText);
    }

    await storeMessage(roomId, client.user.id, 'assistant', responseText);
    console.log('Assistant response sent and added to room history');
  } catch (error) {
    console.error('Error processing assistant message:', error);
    message.channel.send('OOPS I DONE GOOFED');
  }
};