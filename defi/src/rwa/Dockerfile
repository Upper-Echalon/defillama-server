# Use an official Node.js runtime as a parent image
FROM node:20
# Install pnpm globally
RUN npm install -g pnpm
ARG CUSTOM_GIT_BRANCH_DEPLOYMENT
ENV CUSTOM_GIT_BRANCH_DEPLOYMENT=${CUSTOM_GIT_BRANCH_DEPLOYMENT}


# Set the working directory in the container to /app
WORKDIR /app

# Deploy key as a build arg, base64-encoded to a single line (Coolify injects
# build args as literal `ARG` lines, so a raw multi-line PEM breaks parsing).
# Produce it with: base64 -w0 deploy_key
# Leave empty to clone the public repo over HTTPS.
ARG DEPLOY_KEY=""

# Clone the repo. If DEPLOY_KEY is set, install it and clone the private repo over
# SSH (the key is kept so runtime pulls keep working); otherwise clone over HTTPS.
# If CUSTOM_GIT_BRANCH_DEPLOYMENT is set, clone that branch instead of the default.
RUN if [ -n "$DEPLOY_KEY" ]; then \
        mkdir -p ~/.ssh && chmod 700 ~/.ssh; \
        echo "$DEPLOY_KEY" | base64 -d > ~/.ssh/id_rsa; \
        chmod 600 ~/.ssh/id_rsa; \
        ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null; \
        REPO_URL="git@github.com:DefiLlama/defillama-server.git"; \
        echo "Using SSH to clone the repo"; \
    else \
        REPO_URL="https://github.com/DefiLlama/defillama-server"; \
    fi; \
    if [ -n "$CUSTOM_GIT_BRANCH_DEPLOYMENT" ]; then \
        git clone -b "$CUSTOM_GIT_BRANCH_DEPLOYMENT" "$REPO_URL" /app/repo; \
    else \
        git clone "$REPO_URL" /app/repo; \
    fi


# Change to the directory of your repo
WORKDIR /app/repo/defi

# RUN git checkout api-v2-dimensions

# Make port 5001 available to the world outside this container
EXPOSE 5001

# bash command to keep the container running
CMD ["bash", "-c", "bash src/rwa/rwa_start.sh; while true; do sleep 10000; done"]