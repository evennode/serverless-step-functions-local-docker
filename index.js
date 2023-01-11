const path = require('path');
const StepFunctionsLocal = require('stepfunctions-localhost');
const AWS = require('aws-sdk');
const tcpPortUsed = require('tcp-port-used');
const chalk = require('chalk');

class ServerlessStepFunctionsLocal {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;

    this.log = serverless.cli.log.bind(serverless.cli);
    this.config = (this.service.custom && this.service.custom.stepFunctionsLocal) || {};

    if (this.service.stage !== undefined) {
      this.stage = this.service.stage;
    } else if (this.service.provider !== undefined && this.service.provider.stage !== undefined) {
      this.stage = this.service.provider.stage;
    } else {
      this.stage = 'dev';
    }

    // Check config
    if (this.config.accountId === undefined) {
      throw new Error('Step Functions Local: missing accountId');
    }

    if (!this.config.region) {
      throw new Error('Step Functions Local: missing region');
    }

    if (!this.config.lambdaEndpoint) {
      this.config.lambdaEndpoint = 'http://localhost:4000';
    }

    if (!this.config.path) {
      this.config.path = './.step-functions-local';
    }

    if (this.config.startStepFunctionsLocalApp === undefined) {
      this.config.startStepFunctionsLocalApp = true
    }

    if (this.config.waitToStart === undefined) {
      this.config.waitToStart = true
    }

    this.stepfunctionsServer = new StepFunctionsLocal(this.config);

    this.stepfunctionsAPI = new AWS.StepFunctions({endpoint: 'http://localhost:8083', region: this.config.region});

    this.hooks = {
      'offline:start:init': async () => {
        if (this.config.startStepFunctionsLocalApp) {
          await this.installStepFunctions();
        }

        const bootstrap = (async () => {
          await this.startStepFunctions();
          await this.getStepFunctionsFromConfigurationInput();
          await this.createEndpoints();
        })()

        if(this.config.waitToStart) {
          await bootstrap;
        } else {
          bootstrap.catch(err => {
            console.error(chalk.red('[Serverless Step Functions Local]'), 'Could not detect AWS Step Functions emulator running on port 8083.');
          })
        }
      },
      'before:offline:start:end': async () => {
        if (this.config.startStepFunctionsLocalApp) {
          await this.stopStepFunctions();
        }
      }
    };
  }

  installStepFunctions() {
    return this.stepfunctionsServer.install();
  }

  async startStepFunctions() {
    if (this.config.startStepFunctionsLocalApp) {
      this.stepfunctionsServer.start({
        account: this.config.accountId.toString(),
        lambdaEndpoint: this.config.lambdaEndpoint
      }).on('data', data => {
        console.log(chalk.blue('[Serverless Step Functions Local]'), data.toString());
      });
    } else {
      console.log(chalk.blue('[Serverless Step Functions Local]'), 'Waiting for AWS Step Functions emulator on port 8083');
    }

    // Wait for server to start
    await tcpPortUsed.waitUntilUsed(8083, 200, 10000);
    console.log(chalk.blue('[Serverless Step Functions Local]'), 'AWS Step Functions emulator detected on 8083');
  }

  stopStepFunctions() {
    return this.stepfunctionsServer.stop();
  }

  async getStepFunctionsFromConfigurationInput() {
    this.stateMachines = this.stateMachineCFARNResolver(this.serverless.configurationInput.stepFunctions.stateMachines);

    if (this.serverless.configurationInput.custom
      && this.serverless.configurationInput.custom.stepFunctionsLocal
      && this.serverless.configurationInput.custom.stepFunctionsLocal.TaskResourceMapping
    ) {
        this.replaceTaskResourceMappings(
          this.serverless.configurationInput.stepFunctions.stateMachines,
          this.serverless.configurationInput.custom.stepFunctionsLocal.TaskResourceMapping
        );
    }
  }

  /**
   * Replaces Resource properties with values mapped in TaskResourceMapping
   */
  replaceTaskResourceMappings(input, replacements, parentKey) {
    for(var key in input) {
      var property = input[key];
      if (['object', 'array'].indexOf(typeof property) > -1) {
        if (input['Resource'] && replacements[parentKey]) {
          input['Resource'] = replacements[parentKey];
        }
        // Recursive replacement of nested states
        this.replaceTaskResourceMappings(property, replacements, key);
      }
    }
  }

  async createEndpoints() {
    // Delete existing state machines
    const EMPTY = Symbol('empty')
    let nextToken = EMPTY
    const knownStateMachines = Object.keys(this.stateMachines)
    // A state machine is eventually deleted.
    // We need to wait until it's actually deleted because otherwise
    // the new state machine created later is deleted as well and is not
    // available.
    while (true) {
      let hasRunningMachine = false
      while (nextToken) {
        const data = await this.stepfunctionsAPI.listStateMachines({
          nextToken: (nextToken === EMPTY ? undefined : nextToken)
        }).promise()

        nextToken = data.nextToken
        for (const machine of data.stateMachines) {
          if (!knownStateMachines.includes(machine.name)) {
            continue
          }
          hasRunningMachine = true

          await this.stepfunctionsAPI.deleteStateMachine({
            stateMachineArn: machine.stateMachineArn
          })
            .promise()
            .catch(err => {
              // state machine was not found
              if (err && err.code === 400) {
                return
              }

              throw err
            })
        }
      }

      if (!hasRunningMachine) {
        break
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
      console.log(chalk.blue('[Serverless Step Functions Local]'), 'Retrying old state machine removal');
    }

    const endpoints = await Promise.all(Object.keys(this.stateMachines).map(stateMachineName => this.stepfunctionsAPI.createStateMachine({
      definition: JSON.stringify(this.stateMachines[stateMachineName].definition),
      name: stateMachineName,
      roleArn: `arn:aws:iam::${this.config.accountId}:role/DummyRole`
    }).promise()
    ));

    // Set environment variables with references to ARNs
    endpoints.forEach(endpoint => {
      process.env[`OFFLINE_STEP_FUNCTIONS_ARN_${endpoint.stateMachineArn.split(':')[6]}`] = endpoint.stateMachineArn;
    });
  }

  /**
   * Pure Function that will parse Fn:GetAtt and !GetAtt CloudFormation functions from state machine
   */
  stateMachineCFARNResolver(stateMachines) {
    const newStateMachines = { ...stateMachines }

    for (const [stateMachineName, stateMachine] of Object.entries(newStateMachines)) {
      stateMachine.definition.States = this.statesCFARNResolver(stateMachine.definition.States);
    }

    return newStateMachines;
  }

  /**
   * Pure Function that will parse Fn:GetAtt and !GetAtt CloudFormation functions from States
   */
  statesCFARNResolver(states) {
    const newStates = { ...states }

    for (const [stateName, state] of Object.entries(newStates)) {
      switch (state.Type) {
        case 'Task':
          if (state.Resource && state.Resource['Fn::GetAtt'] && Array.isArray(state.Resource['Fn::GetAtt'])) {
            state.Resource = `arn:aws:lambda:${this.config.region}:${this.config.accountId}:function:${this.service.service}-${this.stage}-${state.Resource['Fn::GetAtt'][0]}`
          }
          break;
        case 'Map':
          state.Iterator.States = this.statesCFARNResolver(state.Iterator.States);
          break;
        case 'Parallel':
          for (const branch of state.Branches) {
            branch.States = this.statesCFARNResolver(branch.States);
          }
          break;
        default:
          // ignore
          break;
      }
    }

    return newStates;
  }
}

module.exports = ServerlessStepFunctionsLocal;
