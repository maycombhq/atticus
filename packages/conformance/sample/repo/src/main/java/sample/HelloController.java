package sample;

@RestController
@RequestMapping("/hello")
public class HelloController {
  @GetMapping("/{name}")
  public String hello(@PathVariable String name) {
    return "hello " + name;
  }
}
