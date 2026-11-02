FROM node:22-alpine
WORKDIR /app
ENV TZ=Europe/Belgrade
RUN apk add --no-cache tzdata
COPY package*.json ./
# tsx je u devDependencies, a API se pokreće preko tsx-a, pa instaliramo sve
RUN npm ci
COPY . .
RUN mkdir -p /app/storage
EXPOSE 4000
CMD ["sh", "-c", "npm run migrate && npm start"]
