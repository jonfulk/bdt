const request  = require("request");
const crypto   = require("crypto");
const jwt      = require("jsonwebtoken");
const jwkToPem = require("jwk-to-pem");
const _        = require("lodash");
const expect   = require("code").expect;
const { URL }  = require("url");

/**
 * Deletes all the properties of an object that have value equal to the provided
 * one. This is useful to filter out undefined values for example.
 * @param {Object} obj The object to modify
 * @param {*} value The value to look for
 * @param {Boolean} deep If true the function will walk recursively into nested objects
 */
function stripObjectValues(obj, value, deep)
{
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const val = obj[key];
            if (val && typeof val == "object" && deep) {
                stripObjectValues(obj, value);
            }
            if (val === value) {
                delete obj[key];
            }
        }
    }
    return obj;
}

/**
 * A wrapper for the request function. Returns the request object that you can
 * either pipe to, or use `request(options).promise().then().catch()
 * @param {Object|String} options
 */
function customRequest(options)
{
    /**
     * @type {*}
     */
    let req = {};

    const promise = new Promise((resolve, reject) => {

        if (typeof options == "string") {
            options = { url: options };
        }

        try {
            req = request(options, (error, response, body) => {
                if (error) {
                    return reject(error);
                }
                resolve({ response, body, request: req });
            });
        }
        catch (error) {
            reject(error);
        }
    });

    req.promise = () => promise;

    return req;
}

function wait(ms)
{
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function createClientAssertion(claims = {}, signOptions = {}, privateKey)
{
    let jwtToken = {
        exp: Date.now() / 1000 + 300, // 5 min
        jti: crypto.randomBytes(32).toString("hex"),
        ...claims
    };

    const _signOptions = {
        algorithm: privateKey.alg,
        keyid: privateKey.kid,
        ...signOptions,
        header: {
            // jku: jwks_url || undefined,
            kty: privateKey.kty,
            ...signOptions.header
        }
    };

    return jwt.sign(jwtToken, jwkToPem(privateKey, { private: true }), _signOptions);
}

async function authorize({ tokenEndpoint, clientId, privateKey, strictSSL })
{
    const { response } = await customRequest({
        method   : "POST",
        uri      : tokenEndpoint,
        json     : true,
        strictSSL: !!strictSSL,
        form     : {
            scope                : "system/*.read",
            grant_type           : "client_credentials",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion     : createClientAssertion({
                aud: tokenEndpoint,
                iss: clientId,
                sub: clientId
            }, {}, privateKey)
        }
    }).promise();

    if (!response.body.access_token) {
        throw new Error(
            `Unable to authorize. The authorization request returned ${
                response.statusCode
            }: "${response.statusMessage}"`
        );
    }

    return response.body.access_token;
}

function expectStatusCode(response, code, prefix = "")
{
    expect(response.statusCode, prefix || `response.statusCode must be "${code}"`).to.equal(code);
}

function expectStatusText(response, text, prefix = "")
{
    expect(response.statusMessage, prefix || `response.statusCode must be "${text}"`).to.equal(text);
}

function expectUnauthorized(response, prefix = "")
{
    expectStatusCode(response, 401, prefix);

    if (response.statusMessage) {
        expectStatusText(response, "Unauthorized", prefix);
    }
}

function expectJson(response, prefix = "the server must reply with JSON content-type header")
{
    expect(response.headers["content-type"] || "", prefix).to.match(/^application\/json\b/);
}

function expectOperationOutcome(response, prefix = "")
{
    prefix = prefix ? prefix + " " : prefix;

    if (!response.body) {
        throw new Error(
            prefix + "Expected the request to return an OperationOutcome but " +
            "the response has no body."
        );
    }

    if (response.headers["content-type"].startsWith("application/xml")) {
        if (!response.body.match(/^<OperationOutcome\b.*?<\/OperationOutcome>$/)) {
            throw new Error(
                prefix + "Expected the request to return an OperationOutcome"
            );
        }
    }
    else if (response.headers["content-type"].startsWith("application/json")) {
        let body;
        if (typeof response.body == "string") {
            try {    
                body = JSON.parse(response.body);
            } catch (ex) {
                throw new Error(
                    prefix + "Expected the request to return an " + 
                    "OperationOutcome but the response body cannot be parsed as JSON."
                );
            }
        } else {
            body = response.body;
        }

        if (body.resourceType !== "OperationOutcome") {
            throw new Error(
                prefix + "Expected the request to return an OperationOutcome"
            );
        }
    }
}

class BulkDataClient
{
    constructor(options, testApi, uri)
    {
        this.options         = options;
        this.testApi         = testApi;
        this.url             = new URL(uri);
        this.kickOffRequest  = null;
        this.kickOffResponse = null;
        this.statusRequest   = null;
        this.statusResponse  = null;
        this.cancelRequest   = null;
        this.cancelResponse  = null;
        this.accessToken     = null;
    }

    /**
     * This is an async getter for the access token. 
     */
    async getAccessToken()
    {
        if (!this.accessToken) {
            this.accessToken = await authorize(this.options);
        }
        return this.accessToken;
    }

    /**
     * Starts an export by making a request to the kick-off endpoint. Custom
     * request options can be passed to override the default ones. If any of
     * those option has undefined value it will actually remove that property.
     * For example, ti remove the accept header you can pass
     * `{ headers: { accept: undefined }}`.
     * @param {Object} options Custom request options
     */
    async kickOff(options)
    {
        let requestOptions = _.defaultsDeep({
            uri      : this.url.href,
            json     : true,
            strictSSL: this.options.strictSSL,
            headers: {
                accept: "application/fhir+json",
                prefer: "respond-async"
            },
            ...options
        });

        if (this.options.requiresAuth) {
            const accessToken = await this.getAccessToken();
            requestOptions.headers.authorization = "Bearer " + accessToken;
        }

        stripObjectValues(requestOptions, undefined, true);
        // requestOptions         = _.omitBy(requestOptions, val => val === undefined);
        // requestOptions.headers = _.omitBy(requestOptions.headers, val => val === undefined);
        // console.log(requestOptions)

        this.kickOffRequest = customRequest(requestOptions);
        this.testApi.logRequest(this.kickOffRequest, "Kick-off Request");
        const { response } = await this.kickOffRequest.promise();
        this.kickOffResponse = response;
        this.testApi.logResponse(this.kickOffResponse, "Kick-off Response");
    }

    async status()
    {
        if (!this.kickOffResponse) {
            throw new Error(
                "Trying to check status but there was no kick-off response"
            );
        }

        if (!this.kickOffResponse.headers["content-location"]) {
            throw new Error(
                "Trying to check status but the kick-off response did not include a content-location header"
            );
        }

        this.statusRequest = customRequest({
            uri      : this.kickOffResponse.headers["content-location"],
            json     : true,
            strictSSL: this.options.strictSSL,
            headers: {
                authorization: this.kickOffRequest.headers.authorization
            }
        });

        this.testApi.logRequest(this.statusRequest, "Status Request");
        const { response } = await this.statusRequest.promise();
        this.statusResponse = response;
        this.testApi.logResponse(this.statusResponse, "Status Response");
    }

    async waitForExport(suffix = 1) {
        if (!this.kickOffResponse) {
            throw new Error(
                "Trying to wait for export but there was no kick-off response"
            );
        }

        if (!this.kickOffResponse.headers["content-location"]) {
            throw new Error(
                "Trying to wait for export but the kick-off response did not include a content-location header"
            );
        }

        this.statusRequest = customRequest({
            uri      : this.kickOffResponse.headers["content-location"],
            json     : true,
            strictSSL: this.options.strictSSL,
            headers: {
                authorization: this.kickOffRequest.headers.authorization
            }
        });

        if (suffix === 1) {
            this.testApi.logRequest(this.statusRequest, "Status Request");
        }
        const { response } = await this.statusRequest.promise();
        this.statusResponse = response;
        this.testApi.logResponse(this.statusResponse, "Status Response " + suffix);
        if (response.statusCode === 202) {
            await wait(5000);
            return this.waitForExport(suffix + 1);
        }
    }

    async getExportResponse() {
        if (!this.statusResponse) {
            await this.kickOff();
            await this.waitForExport();
        }
        return this.statusResponse;
    }

    async downloadFileAt(index, skipAuth = null) {
        await this.kickOff();
        await this.waitForExport();

        const fileUrl = this.statusResponse.body.output[index].url;

        const requestOptions = {
            uri: fileUrl,
            strictSSL: this.options.strictSSL,
            json: true,
            gzip: true,
            headers: {
                accept: "application/fhir+json"
            }
        };

        if (!skipAuth) {
            const accessToken = await this.getAccessToken();
            requestOptions.headers = {
                ...requestOptions.headers,
                authorization: "Bearer " + accessToken
            };
        }

        const req = customRequest(requestOptions);
        this.testApi.logRequest(req, "Download Request");
        const { response } = await req.promise();
        this.testApi.logResponse(response, "Download Response");
        return response;
    }

    async cancelIfStarted()
    {
        if (this.kickOffResponse &&
            this.kickOffResponse.statusCode === 202 &&
            this.kickOffResponse.headers["content-location"]) {
            await this.cancel();
        }
    }

    async cancel()
    {
        if (!this.kickOffResponse) {
            throw new Error(
                "Trying to cancel but there was no kick-off response"
            );
        }

        if (!this.kickOffResponse.headers["content-location"]) {
            throw new Error(
                "Trying to cancel but the kick-off response did not include a content-location header"
            );
        }

        this.cancelRequest = customRequest({
            uri      : this.kickOffResponse.headers["content-location"],
            method   : "DELETE",
            json     : true,
            strictSSL: this.options.strictSSL,
            headers: {
                authorization: this.kickOffRequest.headers.authorization
            }
        });

        this.testApi.logRequest(this.cancelRequest, "Cancellation Request");
        const { response } = await this.cancelRequest.promise();
        this.cancelResponse = response;
        this.testApi.logResponse(this.cancelResponse, "Cancellation Response");
    }

    /**
     * Verifies that a request sent to the kick-off endpoint was not successful.
     */
    expectFailedKickOff()
    {
        expect(
            this.kickOffResponse.statusCode,
            "kickOffResponse.statusCode is expected to be >= 400"
        ).to.be.above(399);
        
        // Some servers return empty status message (regardless of the status code).
        // This is odd, but we allow it here as it is not critical
        if (this.kickOffResponse.statusMessage) {
            expectStatusText(this.kickOffResponse, "Bad Request", "kickOffResponse.statusMessage");
        }

        expectOperationOutcome(
            this.kickOffResponse,
            "In case of error the server should return an OperationOutcome."
        );
    }

    /**
     * Verifies that a request sent to the kick-off endpoint was not successful.
     */
    expectSuccessfulKickOff()
    {
        expect(
            this.kickOffResponse.statusCode,
            "kickOffResponse.statusCode is expected to be 202"
        ).to.equal(202);

        expect(
            this.kickOffResponse.headers,
            "The kick-off response must include a content-location header"
        ).to.include("content-location");

        // The body is optional but if set, it must be OperationOutcome
        if (this.kickOffResponse.body) {
            expectOperationOutcome(this.kickOffResponse);
        }
    }
}

module.exports = {
    request: customRequest,
    createClientAssertion,
    expectOperationOutcome,
    expectStatusCode,
    expectUnauthorized,
    expectJson,
    authorize,
    wait,
    BulkDataClient
};