# (A5-07, auditoría 2026-11-11) Imagen de producción para WHATSPOWER (Capa 2A).
# Cero dependencias de runtime (Node stdlib + strip-types) → imagen mínima y
# superficie mínima. Se ejecuta como usuario sin privilegios; los volúmenes
# montados (db/) deben ser escribibles por uid 1000.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY tests ./tests
RUN addgroup -S albra && adduser -S albra -G albra && mkdir -p /app/db && chown -R albra:albra /app
USER albra
EXPOSE 3003
CMD ["node", "--experimental-strip-types", "src/server.ts"]
