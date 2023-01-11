# serverless-step-functions-local-docker

[![NPM Version][npm-version-image]][npm-url]

Run AWS step functions offline with Serverless.

This is a plugin for the [Serverless Framework](https://serverless.com/). It uses [stepfunctions-localhost](https://www.npmjs.com/package/stepfunctions-localhost) to emulate step functions with AWS' provided tool for local development. Alternatively you can run your own emulator such as [aws-stepfunctions-local](https://hub.docker.com/r/amazon/aws-stepfunctions-local) docker container.

## Requirements

- The [serverless-offline](https://www.npmjs.com/package/serverless-offline) plugin
- The [serverless-step-functions](https://www.npmjs.com/package/serverless-step-functions) plugin
- (optional) Java Runtime Engine (JRE) version 6.x or newer if you don't run your own AWS Step Functions emulator

## Install

`npm install serverless-step-functions-local-docker -D`

## Getting Started

You'll need to add this plugin to your `serverless.yml`.  The plugins section should look something like this when you're done:

```yaml
plugins:
  ...
  - serverless-step-functions
  - serverless-step-functions-local-docker
  - serverless-offline
  ...
```

Then, add a new section to `config` with `accountId` and `region` parameters:

```yaml
custom:
  stepFunctionsLocal:
    accountId: 101010101010
    region: us-east-1
```

Although not neccessary, it's strongly recomended to add the folder with the downloaded step function executables to `.gitignore`.  By default, this path is `./.step-functions-local`.

If you decide to start the emulator automatically through `startStepFunctionsLocalApp: true` the plugin binds to port 8083, this cannot be changed.

It also adds an environment variable for each created state machine that contains the ARN for it.  These variables are prefixed by `OFFLINE_STEP_FUNCTIONS_ARN_`, so the ARN of a state machine named 'WaitMachine', for example could be fetched by reading `OFFLINE_STEP_FUNCTIONS_ARN_WaitMachine`.

## Options

(These go under `custom.stepFunctionsLocal`.)

- `accountId` (required) your AWS account ID
- `region` (required) your AWS region
- `lambdaEndpoint` (defaults to `http://localhost:4000`) the endpoint for the lambda service
- `path` (defaults to `./.step-functions-local`) the path to store the downloaded step function executables
- `TaskResourceMapping` allows for Resource ARNs to be configured differently for local development
- `startStepFunctionsLocalApp` (default: `true`) starts AWS step function emulator. Set to false if it's running already. It needs to run on port 8083.  
- `waitToStart` (default: `true`) waits on startup until AWS step function emulator is detected on port 8083
  - `true` throws an error and stops serverless if emulator is not detected
  - `false` emits an error to console and keeps serverless running if emulator is not detected

### Full Config Example

```yaml
service: local-step-function

plugins:
  - serverless-step-functions
  - serverless-step-functions-local-docker
  - serverless-offline

provider:
  name: aws
  runtime: nodejs10.x


custom:
  stepFunctionsLocal:
    accountId: 101010101010
    region: us-east-1
    TaskResourceMapping:
      FirstState: arn:aws:lambda:us-east-1:101010101010:function:hello
      FinalState: arn:aws:lambda:us-east-1:101010101010:function:hello
    startStepFunctionsLocalApp: true
    waitToStart: true

functions:
  hello:
    handler: handler.hello

stepFunctions:
  stateMachines:
    WaitMachine:
      definition:
        Comment: "An example of the Amazon States Language using wait states"
        StartAt: FirstState
        States:
          FirstState:
            Type: Task
            Resource: Fn::GetAtt: [hello, Arn]
            Next: wait_using_seconds
          wait_using_seconds:
            Type: Wait
            Seconds: 10
            Next: FinalState
          FinalState:
            Type: Task
            Resource: Fn::GetAtt: [hello, Arn]
            End: true
```

### Running AWS Step functions emulator in Docker
```bash
$ docker run \
    -p 8083:8083 \
    -e "AWS_ACCOUNT_ID=101010101010" \
    -e "AWS_DEFAULT_REGION=us-east-1" \
    -e "LAMBDA_ENDPOINT=http://localhost:3002" \
    amazon/aws-stepfunctions-local
```

[npm-url]: https://npmjs.org/package/serverless-step-functions-local-docker
[npm-version-image]: https://badgen.net/npm/v/serverless-step-functions-local-docker
