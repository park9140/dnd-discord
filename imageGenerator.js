import axios from 'axios';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';

const workflowPath = './comfyui/workflow.json';

export async function generateImage(promptWithMetadata) {
    try {
        console.log('Generating image with prompt:', promptWithMetadata);

        // Parse the prompt, aspect ratio, and seed using regex
        const aspectRatioRegex = /aspectratio:\s*(\d+:\d+)/i;
        const seedRegex = /seed:\s*(\d+)/i;

        const aspectRatioMatch = promptWithMetadata.match(aspectRatioRegex);
        const seedMatch = promptWithMetadata.match(seedRegex);

        const aspectRatio = aspectRatioMatch ? aspectRatioMatch[1] : '1:1';
        const seed = seedMatch ? parseInt(seedMatch[1]) : Math.floor(Math.random() * 1000000000);
        console.log('Seed:', seed);
        console.log('Aspect Ratio:', aspectRatio);
        // Remove aspect ratio and seed from the prompt
        let prompt = promptWithMetadata
            .replace(aspectRatioRegex, '')
            .replace(seedRegex, '')
            .trim();

        // Calculate dimensions for a 2 megapixel image
        const targetPixels = 2000000;
        const [width, height] = calculateDimensions(aspectRatio, targetPixels);

        // Read the workflow JSON file
        const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
        
        // Update the workflow with the new prompt, dimensions, and seed
        workflow[6].inputs.text = prompt;
        workflow[25].inputs.noise_seed = seed;
        workflow[27].inputs.width = width;
        workflow[27].inputs.height = height;
        workflow[30].inputs.width = width;
        workflow[30].inputs.height = height;

        // Queue the prompt
        const queueResponse = await axios.post('http://127.0.0.1:8188/prompt', {
            prompt: workflow
        });

        console.log('Queue Response:', queueResponse.data);

        // Get the prompt ID from the queue response
        const promptId = queueResponse.data.prompt_id;

        // Poll for the image generation status
        let imageGenerated = false;
        let historyResponse;
        while (!imageGenerated) {
            historyResponse = await axios.get(`http://127.0.0.1:8188/history/${promptId}`);
            if (historyResponse.data[promptId] && historyResponse.data[promptId].outputs && historyResponse.data[promptId].outputs['9']) {
                imageGenerated = true;
            } else {
                // Wait for a short time before polling again
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log('Image generated:', historyResponse.data[promptId].outputs['9']);
        // Get the generated image details
        const imageDetails = historyResponse.data[promptId].outputs['9'].images[0];
        const imageUrl = `http://127.0.0.1:8188/view?filename=${imageDetails.filename}&subfolder=${imageDetails.subfolder}&type=output`;
        
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });

        const imageBuffer = Buffer.from(imageResponse.data);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'generated_image.png' });

        const embed = new EmbedBuilder()
            .setImage('attachment://generated_image.png');

        return { embed, attachment };
    } catch (error) {
        console.error('Error generating image:', error);
        throw error;
    }
}

function calculateDimensions(aspectRatio, targetPixels) {
    const [w, h] = aspectRatio.split(':').map(Number);
    const ratio = w / h;
    let height = Math.sqrt(targetPixels / ratio);
    let width = height * ratio;

    // Ensure dimensions are even numbers
    width = Math.round(width / 2) * 2;
    height = Math.round(height / 2) * 2;

    return [width, height];
}

export async function generateImagePrompt(ragApplication, situationSummary, dmResponse, operationMode) {
    let imageGenerationPrompt = `
        Generate a prompt describing an image based on the following situation summary and DM response:
        Situation Summary: ${situationSummary}
        DM Response: ${dmResponse}

        The prompt should be written like comma separated set of phrases, use descriptors and styles but don't use flowery language.
        You can use parentheses followed by a number ex:(phrase)1.2 where the thing is something you want to emphasize and the number is between 1.1 and 2.0 level of emphasis
        You can add ++ which squares the importance or +++ to cube it
    `;

    if (operationMode === 'battle') {
        imageGenerationPrompt += 'The image should use a battle map style if it makes sense for the current situation.';
    } else {
        imageGenerationPrompt += 'The image should be clear and detailed, highlighting an aspect of the current situation.';
    }

    const ragImageResponse = await ragApplication.query(imageGenerationPrompt);
    return ragImageResponse.content.trim();
}