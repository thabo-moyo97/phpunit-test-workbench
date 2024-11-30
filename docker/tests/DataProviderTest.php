<?php

declare(strict_types=1);

namespace Tests;

use PHPUnit\Framework\TestCase;
use Generator;

final class DataProviderTest extends TestCase
{
    public static function additionProvider(): Generator
    {
        yield 'positive_numbers' => [1, 1, 2];
        yield 'negative_numbers' => [-1, -1, -2];
        yield 'mixed_numbers' => [-1, 1, 0];
    }

    /**
     * @dataProvider additionProvider
     */
    public function testAdd(int $a, int $b, int $expected): void
    {
        $this->assertEquals($expected, $a + $b);
    }

    public static function multiplicationProvider(): Generator
    {
        yield 'positive_numbers' => [1, 3, 3];
        yield 'negative_numbers' => [-2, -3, 6];
        yield 'mixed_numbers' => [-2, 3, -6];
    }

    /**
     * @dataProvider multiplicationProvider
     */
    public function testMultiply(int $a, int $b, int $expected): void
    {
        $this->assertEquals($expected, $a * $b);
    }

    public function testSimple(): void
    {
        $this->assertTrue(true);
    }
}
