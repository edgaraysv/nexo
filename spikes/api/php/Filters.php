<?php
namespace Config;

use CodeIgniter\Config\Filters as BaseFilters;

// Laboratorio HTTP loopback sin sesiones: sin debug toolbar ni forceHTTPS.
class Filters extends BaseFilters
{
    public array $aliases = [];
    public array $required = ['before' => [], 'after' => []];
    public array $globals = ['before' => [], 'after' => []];
    public array $methods = [];
    public array $filters = [];
}
