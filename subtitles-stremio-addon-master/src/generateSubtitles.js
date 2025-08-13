/* eslint-disable no-unused-vars */
require('dotenv').config()
const OS = require('opensubtitles-api')
const axios = require('axios')
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
})

// Inicializar el cliente de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-pro' })

async function openSubtitles (data) {
  try {
    const OpenSubtitles = new OS({
      useragent: 'UserAgent',
      ssl: true
    })

    const query = {
      extensions: ['srt'],
      limit: '10',
      ...data
    }

    const subtitles = await OpenSubtitles.search(query)

    if (!Object.keys(subtitles).length) {
      console.log('No subtitles found')
      return null
    }

    return subtitles
  } catch (error) {
    console.log('Error on open subtitles method', error)
    return null
  }
}

function formatSubtitles (subtitles) {
  if (!subtitles) {
    console.log('No subtitles to format')
    return []
  }

  // 'sp' no es un código de idioma estándar, 'es' es para español.
  // OpenSubtitles puede usarlo, pero es bueno tenerlo en cuenta.
  const languages = ['en', 'es']

  const formattedSubtitles = []
  languages.forEach(langCode => {
    if (subtitles[langCode] && Array.isArray(subtitles[langCode])) {
      subtitles[langCode].forEach((data, index) => {
        formattedSubtitles.push({
          id: `${langCode}-${index + 1}`,
          url: data.utf8,
          lang: data.lang
        })
      })
    }
  })

  return formattedSubtitles
}

async function translateSubtitles (formattedSubtitles, videoId) {
  const englishSubtitlesUrls = formattedSubtitles.map(subtitle => {
    if (subtitle?.id?.includes('en')) {
      return subtitle.url
    }
    return null
  })?.filter(Boolean)
  
  const s3KeyPrefix = videoId.replace(':', '_') // Create a unique prefix for this video
  
  try {
    const translationPromises = englishSubtitlesUrls.map(async (url, index) => {
      const englishSubtitleResponse = await axios.get(url, { responseType: 'text' })
      const originalSrt = englishSubtitleResponse.data

      // --- Lógica de traducción con Gemini ---
      const prompt = `
      Eres un experto traductor de subtítulos.
      Traduce el siguiente contenido de un archivo SRT de inglés a español latinoamericano neutro.
      IMPORTANTE: No traduzcas ni modifiques los números de secuencia, los códigos de tiempo (timestamps), ni ninguna etiqueta de formato SRT como <i>, <b>, etc.
      Solo traduce las líneas de diálogo. Mantén la estructura del archivo SRT intacta.

      Contenido SRT a traducir:
      ---
      ${originalSrt}
      ---
      `
      const result = await model.generateContent(prompt)
      const response = await result.response
      const translatedSrt = response.text()
      // --- Fin de la lógica de traducción ---

      const s3Key = `${s3KeyPrefix}_translated_en_${index + 1}.srt`
      const savedFileUrl = await uploadTranslatedSubtitleToS3(s3Key, translatedSrt)
      return savedFileUrl
    })

    const results = await Promise.allSettled(translationPromises)
    const translatedSubtitlesUrls = results
      .filter(result => result.status === 'fulfilled' && result.value)
      .map(result => result.value)

    const translatedSubtitles = translatedSubtitlesUrls.map((url, index) => ({
      id: `translated-${index + 1}`,
      url,
      lang: 'Español (Traducido)'
    }))

    return translatedSubtitles
  } catch (error) {
    console.log('Error on fetch and translate english subtitles', error)
    return []
  }
}

async function uploadTranslatedSubtitleToS3 (key, subtitle) {
  const bucket = process.env.AWS_BUCKET_NAME
  const uploadParams = {
    Bucket: bucket,
    Key: key,
    Body: subtitle
  }

  const getParams = {
    Bucket: bucket,
    Key: key
  }

  try {
    const uploadCommand = new PutObjectCommand(uploadParams)
    await s3Client.send(uploadCommand)

    const getCommand = new GetObjectCommand(getParams)
    const presignedUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 })
    console.log('File uploaded successfully')

    return presignedUrl
  } catch (err) {
    console.error('File not uploaded', err)
  }
}

async function generateSubtitles (data) {
  const subtitles = await openSubtitles(data)
  const formattedSubtitles = formatSubtitles(subtitles, data.imdbid)
  const translatedSubtitles = await translateSubtitles(formattedSubtitles, data.imdbid)
  const subtitlesToReturn = [...formattedSubtitles, ...translatedSubtitles]
  console.log(`Found ${subtitlesToReturn.length} subtitles`)

  return subtitlesToReturn
}

module.exports = { generateSubtitles, formatSubtitles, translateSubtitles }
