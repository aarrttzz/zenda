FROM node:22.11.0-slim

# рабочая директория
WORKDIR /app

# копируем package.json и package-lock.json
COPY package*.json ./

# ставим зависимости
RUN npm install --production

# копируем весь код
COPY . .

# создаём папку для WA auth (иначе baileys может упасть)
RUN mkdir -p auth_info

# порт health-check
EXPOSE 3000

# команда запуска
CMD ["node", "index.js"]
