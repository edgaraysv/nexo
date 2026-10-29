FROM composer:2.8.12@sha256:5248900ab8b5f7f880c2d62180e40960cd87f60149ec9a1abfd62ac72a02577c AS composer
FROM php:8.4-cli-bookworm@sha256:836ac6c672d1372a47c8fd61b625015bd07760f493fb2eaab2087636498a2b4b
RUN apt-get update && apt-get install -y --no-install-recommends libicu-dev libonig-dev libpq-dev unzip git \
    && docker-php-ext-install intl mbstring pgsql \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
WORKDIR /lab
COPY spikes/api/php/appstarter ./
RUN composer install --no-dev --prefer-dist --no-interaction --no-scripts \
    && chown -R www-data:www-data writable
COPY spikes/api/php/Spike.php app/Controllers/Spike.php
COPY spikes/api/php/Routes.php app/Config/Routes.php
COPY spikes/api/php/Filters.php app/Config/Filters.php
COPY spikes/api/php/router.php router.php
RUN php -l app/Controllers/Spike.php && php -l app/Config/Routes.php && php -l app/Config/Filters.php
USER www-data
ENV PHP_CLI_SERVER_WORKERS=24
CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "router.php"]
