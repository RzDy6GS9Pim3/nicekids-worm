const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const COS = require('cos-nodejs-sdk-v5');

const configFile = fs.readFileSync('config.json');
const configJson = JSON.parse(configFile);
const [SecretId, SecretKey, Bucket, Region] = [configJson.COS.SecretId, configJson.COS.SecretKey, configJson.COS.Bucket, configJson.COS.Region]

// ffmpeg.setFfmpegPath(path.resolve('ffmpeg/ffmpeg'));
// ffmpeg.setFfprobePath(path.resolve('ffmpeg/ffprobe'));

const cos = new COS({
  SecretId,
  SecretKey,
});

const videoFolder = 'resourceDownloader';

// 获取视频的长和宽
function getVideoSize(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        const { width, height } = metadata.streams[0].coded_width ? metadata.streams[0] : metadata.streams[1];
        resolve({ width, height });
      }
    });
  });
}

// 裁剪视频
function cropVideo(inputFile, outputFile, width, height) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .setStartTime('00:00:04.5')
      .videoFilter(`crop=iw:ih-(${height}*.05)*2,scale=${width}:-1`)
      .on('progress', (progress) => {
        console.log(`Processing: ${Math.round(progress.percent)}%`);
      })
      .on('end', () => {
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      })
      .save(outputFile);
  });
}

// 上传文件到COS
function uploadToCOS(fileName, filePath) {
  return new Promise((resolve, reject) => {
    const params = {
      Bucket,
      Region,
      Key: fileName,
      Body: fs.createReadStream(filePath),
    };
    cos.putObject(params, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// 删除本地文件
function deleteLocalFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.rm(filePath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// 处理单个视频
async function processVideo(fileName) {
  let filePath = path.join(videoFolder, fileName);
  const { width, height } = await getVideoSize(filePath);

  if (width > height) {
    console.log(`Uploading '${fileName}' directly to the storage bucket.`);
  } else {
    console.log(`Processing and uploading '${fileName}'.`);
    await cropVideo(filePath, `${filePath}.cropped.mp4`, width, height);
    filePath = `${filePath}.cropped.mp4`;
  }
  await uploadToCOS(fileName, filePath);
  deleteLocalFile(filePath);
}

// 主函数
async function processVideos() {
  const videoFiles = fs.readdirSync(videoFolder).filter((file) => {
    const extname = path.extname(file).toLowerCase();
    return extname === '.mp4' || extname === '.mov'
  });

  for (const fileName of videoFiles) {
    await processVideo(fileName);
  }
}

processVideos()
  .then(() => {
    console.log('All videos processed and uploaded successfully.');
  })
  .catch((err) => {
    console.error('Error processing videos:', err);
  });
