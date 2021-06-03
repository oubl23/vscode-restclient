import * as CryptoJS from 'crypto-js'

export function jwt(jwtKey: string, jwtSecret: string): string {

    // Set headers for JWT
    var header = {
        'typ': 'JWT',
        'alg': 'HS256'
    };

    // Prepare timestamp in seconds
    var currentTimestamp = Math.floor(Date.now() / 1000)

    var data = {
        'iss': jwtKey,
        'iat': currentTimestamp,
        'exp': currentTimestamp + 30
    }


    function base64url(source) {
        // Encode in classical base64
        let encodedSource = CryptoJS.enc.Base64.stringify(source)

        // Remove padding equal characters
        encodedSource = encodedSource.replace(/=+$/, '')

        // Replace characters according to base64url specifications
        encodedSource = encodedSource.replace(/\+/g, '-')
        encodedSource = encodedSource.replace(/\//g, '_')

        return encodedSource
    }

    // encode header
    var stringifiedHeader = CryptoJS.enc.Utf8.parse(JSON.stringify(header))
    var encodedHeader = base64url(stringifiedHeader)

    // encode data
    var stringifiedData = CryptoJS.enc.Utf8.parse(JSON.stringify(data))
    var encodedData = base64url(stringifiedData)

    // build token
    var token = `${encodedHeader}.${encodedData}`

    // sign token
    var signature = CryptoJS.HmacSHA256(token, jwtSecret)
    signature = base64url(signature)
    var signedToken = `${token}.${signature}`

    return signedToken
}