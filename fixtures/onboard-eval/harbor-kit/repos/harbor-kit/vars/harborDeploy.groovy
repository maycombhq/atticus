// Harbor's shared-library deploy step: harborDeploy(env: 'prod'). Installs the service's Helm
// chart for the environment named by env, then runs the post-deploy smoke tests.
def call(Map args) {
  stage("Deploy to ${args.env}") {
    sh "helm upgrade --install ${env.JOB_BASE_NAME} chart/ -f chart/values-${args.env}.yaml"
  }
  stage('Smoke tests') {
    sh './gradlew smokeTest'
  }
}
