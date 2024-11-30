#!/bin/bash

VENDOR_DIR=/app/vendor
COMPOSER_DIR=/app/composer
COMPOSER_JSON="$COMPOSER_DIR/composer.json"
COMPOSER_LOCK="$COMPOSER_DIR/composer.lock"

# Function to check if dependencies need to be installed (silently)
needs_install() {
    if [ ! -d "$VENDOR_DIR" ] || [ -z "$(ls -A $VENDOR_DIR 2>/dev/null)" ] || [ ! -f "$COMPOSER_LOCK" ]; then
        return 0
    fi
    return 1
} 2>/dev/null

# Create composer.json with specified PHPUnit version
if needs_install >/dev/null 2>&1; then
    # Ensure composer directory exists
    mkdir -p "$COMPOSER_DIR" 2>/dev/null

    # Create initial composer.json with autoloading configuration
    cat > "$COMPOSER_JSON" <<'EOF' 2>/dev/null
{
    "name": "test/phpunit-version-test",
    "type": "project",
    "autoload": {
        "psr-4": {
            "Tests\\\\": "tests/"
        }
    },
    "require-dev": {}
}
EOF

    # Create symlink to composer files in working directory
    ln -sf "$COMPOSER_JSON" /app/composer.json 2>/dev/null
    ln -sf "$COMPOSER_LOCK" /app/composer.lock 2>/dev/null

    # Install PHPUnit version with specific vendor directory (suppress output)
    COMPOSER_VENDOR_DIR=$VENDOR_DIR composer require --dev "$COMPOSER_REQUIRE" --no-interaction > /dev/null 2>&1 || {
        echo "Error installing PHPUnit version: $COMPOSER_REQUIRE"
        exit 1
    }
    COMPOSER_VENDOR_DIR=$VENDOR_DIR composer install --no-interaction > /dev/null 2>&1 || {
        echo "Error running composer install"
        exit 1
    }
    COMPOSER_VENDOR_DIR=$VENDOR_DIR composer dump-autoload > /dev/null 2>&1 || {
        echo "Error generating autoload files"
        exit 1
    }
fi

# Configure Xdebug silently
echo "xdebug.mode=coverage" >> /usr/local/etc/php/conf.d/docker-php-ext-xdebug.ini 2>/dev/null

# Execute the passed command
exec "$@" 2>/dev/null 