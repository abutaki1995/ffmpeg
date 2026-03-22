const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const WORK_DIR = '/tmp/ffmpeg-work';

// Health check
app.get('/health', (req, res) => {
  try {
    const version = execSync('ffmpeg -version').toString().split('\n')[0];
    res.json({ status: 'ok', ffmpeg: version });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Main compose endpoint - matches the workflow needs
app.post('/compose', async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(WORK_DIR, jobId);

  try {
    const { clip_urls, narration_url, music_url, ass_content, options } = req.body;

    // Validate required fields
    if (!clip_urls || !Array.isArray(clip_urls) || clip_urls.length === 0) {
      return res.status(400).json({ error: 'clip_urls is required and must be a non-empty array' });
    }

    // Options with defaults
    const narrationDelay = options?.narration_delay ?? 1000;
    const narrationVolume = options?.narration_volume ?? 0.95;
    const musicVolume = options?.music_volume ?? 0.08;
    const preset = options?.preset ?? 'fast';
    const crf = options?.crf ?? 23;

    console.log(`[${jobId}] Starting job: ${clip_urls.length} clips`);
    fs.mkdirSync(jobDir, { recursive: true });

    // Download all video clips
    console.log(`[${jobId}] Downloading ${clip_urls.length} clips...`);
    for (let i = 0; i < clip_urls.length; i++) {
      execSync(`wget -q -O "${jobDir}/clip${i}.mp4" "${clip_urls[i]}"`, { timeout: 120000 });
    }

    // Download narration if provided
    const hasNarration = narration_url && narration_url.length > 0;
    if (hasNarration) {
      console.log(`[${jobId}] Downloading narration...`);
      execSync(`wget -q -O "${jobDir}/narration.wav" "${narration_url}"`, { timeout: 120000 });
    }

    // Download music if provided
    const hasMusic = music_url && music_url.length > 0;
    if (hasMusic) {
      console.log(`[${jobId}] Downloading music...`);
      execSync(`wget -q -O "${jobDir}/music.wav" "${music_url}"`, { timeout: 120000 });
    }

    // Write concat file
    const concatList = clip_urls.map((_, i) => `file '${jobDir}/clip${i}.mp4'`).join('\n');
    fs.writeFileSync(`${jobDir}/concat.txt`, concatList);

    // Write ASS captions if provided
    const hasCaptions = ass_content && ass_content.length > 0;
    if (hasCaptions) {
      fs.writeFileSync(`${jobDir}/captions.ass`, ass_content);
    }

    // Step 1: Concatenate all clips
    console.log(`[${jobId}] Concatenating clips...`);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${jobDir}/concat.txt" -c copy "${jobDir}/concat_video.mp4"`, {
      timeout: 300000
    });

    // Step 2: Build the final FFmpeg command based on available inputs
    console.log(`[${jobId}] Mixing audio + burning captions...`);
    let cmd = `ffmpeg -y -i "${jobDir}/concat_video.mp4"`;
    let filterComplex = '';
    let mapAudio = '';

    // Add audio inputs and build filter
    if (hasNarration && hasMusic) {
      cmd += ` -i "${jobDir}/narration.wav" -i "${jobDir}/music.wav"`;
      filterComplex = `[1:a]adelay=${narrationDelay}|${narrationDelay},volume=${narrationVolume}[narr];[2:a]volume=${musicVolume}[music];[narr][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
      mapAudio = '-map "[aout]"';
    } else if (hasNarration) {
      cmd += ` -i "${jobDir}/narration.wav"`;
      filterComplex = `[1:a]adelay=${narrationDelay}|${narrationDelay},volume=${narrationVolume}[aout]`;
      mapAudio = '-map "[aout]"';
    } else if (hasMusic) {
      cmd += ` -i "${jobDir}/music.wav"`;
      filterComplex = `[1:a]volume=${musicVolume}[aout]`;
      mapAudio = '-map "[aout]"';
    }

    // Build video filter (captions)
    let videoFilter = '';
    if (hasCaptions) {
      videoFilter = `-vf "ass=${jobDir}/captions.ass"`;
    }

    // Build filter_complex flag
    let filterFlag = '';
    if (filterComplex) {
      filterFlag = `-filter_complex "${filterComplex}"`;
    }

    // Compose final command
    cmd += ` ${filterFlag} ${videoFilter} -map 0:v ${mapAudio}`;
    cmd += ` -c:v libx264 -preset ${preset} -crf ${crf}`;
    cmd += ` -c:a aac -b:a 192k -shortest -movflags +faststart`;
    cmd += ` "${jobDir}/final_output.mp4"`;

    execSync(cmd, { timeout: 600000 });

    // Verify output exists
    if (!fs.existsSync(`${jobDir}/final_output.mp4`)) {
      throw new Error('FFmpeg produced no output file');
    }

    const stats = fs.statSync(`${jobDir}/final_output.mp4`);
    console.log(`[${jobId}] Done! Output: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Send the file back
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="output_${jobId}.mp4"`);
    res.setHeader('X-Job-Id', jobId);
    res.setHeader('X-File-Size', stats.size);

    const readStream = fs.createReadStream(`${jobDir}/final_output.mp4`);
    readStream.pipe(res);

    // Clean up after response is sent
    readStream.on('end', () => {
      setTimeout(() => {
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
      }, 5000);
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);

    // Clean up on error
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}

    res.status(500).json({
      error: error.message,
      jobId: jobId
    });
  }
});

// List active jobs / simple status
app.get('/status', (req, res) => {
  try {
    const jobs = fs.readdirSync(WORK_DIR).filter(f =>
      fs.statSync(path.join(WORK_DIR, f)).isDirectory()
    );
    res.json({ active_jobs: jobs.length, jobs });
  } catch (e) {
    res.json({ active_jobs: 0, jobs: [] });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg service running on port ${PORT}`);
  // Verify ffmpeg is available
  try {
    const version = execSync('ffmpeg -version').toString().split('\n')[0];
    console.log(`FFmpeg: ${version}`);
  } catch (e) {
    console.error('WARNING: FFmpeg not found!');
  }
});
