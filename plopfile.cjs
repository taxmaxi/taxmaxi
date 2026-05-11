const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const validateName = (value) => {
  if (!value) {
    return 'Name is required'
  }

  if (!kebabCaseRegex.test(value)) {
    return 'Use kebab-case (letters, numbers, hyphens)'
  }

  return true
}

module.exports = function registerPlop(plop) {
  plop.setGenerator('workspace-module', {
    description: 'Generate a new app or package in this Turborepo',
    prompts: [
      {
        type: 'list',
        name: 'targetType',
        message: 'What do you want to create?',
        choices: [
          { name: 'App (apps/*)', value: 'app' },
          { name: 'Package (packages/*)', value: 'package' }
        ]
      },
      {
        type: 'input',
        name: 'name',
        message: 'Module name (kebab-case):',
        validate: validateName
      },
      {
        type: 'input',
        name: 'description',
        message: 'Short description:',
        default: 'Generated with Plop'
      },
      {
        type: 'input',
        name: 'scope',
        message: 'NPM scope for package name:',
        default: 'my',
        when: ({ targetType }) => targetType === 'package',
        validate: validateName
      }
    ],
    actions: (answers) => {
      const targetRoot = answers.targetType === 'app' ? 'apps' : 'packages'
      const packageName =
        answers.targetType === 'app'
          ? answers.name
          : `@${answers.scope}/${answers.name}`

      return [
        {
          type: 'addMany',
          destination: `${targetRoot}/${answers.name}`,
          base: `plop-templates/${answers.targetType}`,
          templateFiles: `plop-templates/${answers.targetType}/**/*`,
          data: {
            ...answers,
            packageName
          },
          abortOnFail: true
        }
      ]
    }
  })
}
