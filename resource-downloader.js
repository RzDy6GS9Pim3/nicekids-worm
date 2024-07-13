const mysql = require('mysql2/promise');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');


const downloadDirectory = './resourceDownloader';

const configFile = fs.readFileSync('config.json');
const configJson = JSON.parse(configFile);
const [host, user, password, database] = [configJson.mysql.host, configJson.mysql.user, configJson.mysql.password, configJson.mysql.database];
const domain = configJson.domain;

const dbConfig = {
  host,
  user,
  password,
  database
};


async function downloadFile(url, filename) {
  const response = await axios.get(url, {
    responseType: 'stream', headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      Xweb_xhr: '1',
    },
  },);
  const filePath = path.join(downloadDirectory, filename);
  const writer = fs.createWriteStream(filePath);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function checkVideoIntegrity(filepath) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('ffmpeg', ['-v', 'error', '-i', filepath, '-f', 'null', '-']);
    ffmpegProcess.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('Video is not complete.'));
      }
    });
  });
}

async function main() {
  try {
    const connection = await mysql.createConnection(dbConfig);

    const [rows] = await connection.query(`
      SELECT *
      FROM vapp_prereview_getprereviewresource AS p
      JOIN vapp_lesson_getendlessonlist AS l ON SUBSTRING(p.id, 1, LENGTH(p.id) - 1) = l.lessonid
      WHERE l.lessonname REGEXP 'G3[A-C]-[0-9]'

    `);

    if (!fs.existsSync(downloadDirectory)) {
      fs.mkdirSync(downloadDirectory);
    }

    for (const row of rows) {
      const partList = JSON.parse(row.partList);
      for (const item of partList) {
        const { url } = item;
        const filename = url.substring(url.lastIndexOf('/') + 1);
        const newUrl = url.replace(domain, 'cloud.nicekid.com');

        try {
          await downloadFile(newUrl, filename);
          console.log(`Downloaded: ${filename}`);
          const filePath = path.join(downloadDirectory, filename);
          await checkVideoIntegrity(filePath);
          console.log(`Video is complete: ${filename}`);
        } catch (error) {
          console.error(`Error downloading or checking video: ${filename}`, error);
          // Retry downloading
          continue;
        }
      }
    }

    connection.close();
    console.log('All files downloaded successfully.');
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

main();
