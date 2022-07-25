FROM node:14.17.5-stretch-slim

WORKDIR /app
COPY . /app/

RUN npm i && npm run build
RUN npm install pm2 -g

ENTRYPOINT [ "npm", "start" ]
